import type { ClaudeTurnUsage, CloseLoopIteration, CloseLoopResult, EngineConfig, GateSpec, ReviewFinding, TaskSpec } from "../types.js";
import { runClaudeTurn } from "./claudeEngine.js";
import { establishBaselines, runGates } from "./verify.js";
import { buildFeedbackPrompt, buildInitialPrompt } from "./prompts.js";
import { createWorktree, commitAll } from "./git.js";
import { writeAcceptanceTest } from "./acceptanceTest.js";
import { readMemoryFiles, buildMemoryContextBlock, updateProjectMemory } from "./memory.js";
import { fingerprintFailure } from "./stuckDetector.js";
import { reviewChanges } from "./review.js";
import { generateTestingNotes } from "./testingNotes.js";
import { checkGateIntegrity } from "./gateIntegrity.js";

// input + cache_read + cache_creation is the real total context the model saw this
// turn, not a per-turn delta — confirmed empirically elsewhere (a turn can report
// input_tokens in the single digits while the real context is in the tens of
// thousands, almost all of it served from cache).
export function totalContextTokens(usage: ClaudeTurnUsage): number {
  return usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
}

export async function runCloseLoop(task: TaskSpec, config: EngineConfig): Promise<CloseLoopResult> {
  const worktreeDir = config.existingWorktreeDir ?? (await createWorktree(config.repoPath, config.branchName));

  let totalCostUsd = 0;
  let gates: GateSpec[] = config.gates;
  let extraDeniedPaths = config.extraDeniedPaths;
  let acceptanceTestPath: string | undefined;

  // Writing the acceptance test is a one-shot step, before any implementation work —
  // the test has to capture "before the fix" (expected to fail) honestly, and only
  // this ordering lets implement be mechanically denied Edit/Write on its exact path
  // for the rest of the loop (see extraDeniedPaths below). A write that goes wrong
  // (model errors, or touches more than its one file) degrades to "no acceptance
  // gate" rather than failing the whole task over a meta-step.
  if (task.acceptanceCriteria.length > 0 && config.acceptanceTest) {
    config.onIteration?.({
      iteration: 0,
      phase: "writing_acceptance_test",
      costUsd: 0,
      summary: `Пишу тест приёмки по ${task.acceptanceCriteria.length} критериям`,
    });
    const result = await writeAcceptanceTest(worktreeDir, task, {
      model: config.acceptanceTest.model,
      ext: config.acceptanceTest.ext,
      extraDeniedPaths: config.extraDeniedPaths,
    });
    totalCostUsd += result.costUsd;
    if (result.ok) {
      acceptanceTestPath = result.relPath;
      gates = [...config.gates, { name: "acceptance", command: `${config.acceptanceTest.runner} ${result.relPath}`, strict: true }];
      extraDeniedPaths = [...(config.extraDeniedPaths ?? []), result.relPath];
    } else {
      config.onLog?.(`⚠️ Не удалось зафиксировать тест приёмки (${result.reason}) — продолжаю без него.`);
    }
  }

  // Can take minutes on a real test suite — say so up front, same reasoning as the
  // analyzing-turn message: a long silent gap here reads as "stuck", not "working".
  const gateNames = gates.map((g) => g.name).join(", ");
  config.onIteration?.({ iteration: 0, phase: "baseline", costUsd: totalCostUsd, summary: `Считаю baseline по гейтам: ${gateNames}` });
  const baselines = await establishBaselines(worktreeDir, gates);

  // Read-only context, injected directly rather than left for the agent to stumble
  // onto — the project's own CLAUDE.md only auto-loads AGENTS.md, not memory files.
  const memories = await readMemoryFiles(config.repoPath);
  const memoryContext = buildMemoryContextBlock(memories);

  const iterations: CloseLoopIteration[] = [];
  let prompt = buildInitialPrompt(task, memoryContext);
  let resumeSessionId: string | undefined;
  // Set once a failure happens, compared against the NEXT failure — not the error
  // itself but whether the agent's last edit changed anything about its *nature*.
  // Needs two failed iterations to ever trigger, so a single bad attempt never does.
  let previousFingerprint: string | undefined;

  for (let i = 0; i < config.maxIterations; i++) {
    const remainingBudget = config.maxBudgetUsd - totalCostUsd;
    if (remainingBudget <= 0) {
      return { task, success: false, iterations, totalCostUsd, stopReason: "max_budget", worktreeDir, acceptanceTestPath };
    }

    const turn = await runClaudeTurn({
      cwd: worktreeDir,
      prompt,
      permissionMode: config.permissionMode,
      resumeSessionId,
      maxBudgetUsd: remainingBudget,
      extraDeniedPaths,
      model: config.model,
      onLog: config.onLog,
    });
    totalCostUsd += turn.totalCostUsd;
    resumeSessionId = turn.sessionId;
    config.onIteration?.({ iteration: i + 1, phase: "iterating", costUsd: totalCostUsd, summary: turn.resultText.slice(0, 200) });

    if (turn.isError) {
      iterations.push({ turn, verify: { passed: false, output: turn.resultText, gates: [] } });
      return { task, success: false, iterations, totalCostUsd, stopReason: "agent_error", worktreeDir, acceptanceTestPath };
    }

    config.onIteration?.({ iteration: i + 1, phase: "verifying", costUsd: totalCostUsd, summary: turn.resultText.slice(0, 200) });
    const verify = await runGates(worktreeDir, gates, baselines);
    iterations.push({ turn, verify });

    if (verify.passed) {
      await commitAll(worktreeDir, `${task.id}: ${task.title}\n\nAutomated by jira-harness.`);

      // Runs before review/memory/testing-notes and short-circuits on a hit — if the
      // agent earned "green" by weakening the judge rather than fixing the bug, there's
      // no point spending an LLM turn reviewing that diff, and no retry: unlike a
      // normal gate failure, giving it another attempt just risks it hiding this better.
      if (config.gateIntegrityCheck) {
        config.onIteration?.({
          iteration: i + 1,
          phase: "checking_gate_integrity",
          costUsd: totalCostUsd,
          summary: "Проверяю целостность гейтов",
        });
        const violations = await checkGateIntegrity(worktreeDir, config.gateIntegrityCheck.baseBranch);
        if (violations.length > 0) {
          return {
            task,
            success: false,
            iterations,
            totalCostUsd,
            stopReason: "gate_integrity_violation",
            worktreeDir,
            acceptanceTestPath,
            gateIntegrityViolations: violations.map((v) => v.description),
          };
        }
      }

      // Review runs on every real success, before memory — a change a human ends up
      // rejecting shouldn't also leave a "durable fact" behind as if it shipped clean.
      let reviewFindings: ReviewFinding[] | undefined;
      if (config.review) {
        config.onIteration?.({ iteration: i + 1, phase: "reviewing", costUsd: totalCostUsd, summary: "Ревьюю изменения" });
        const reviewResult = await reviewChanges(worktreeDir, task, config.review);
        totalCostUsd += reviewResult.costUsd;
        reviewFindings = reviewResult.findings;
        if (reviewResult.reason) config.onLog?.(`⚠️ Не удалось провести ревью (${reviewResult.reason})`);

        const blocking = reviewFindings.filter((f) => f.blocking);
        if (blocking.length > 0) {
          return {
            task,
            success: false,
            iterations,
            totalCostUsd,
            stopReason: "review_blocked",
            worktreeDir,
            acceptanceTestPath,
            reviewFindings,
          };
        }
      }

      // Purely informational, never blocking (unlike review) — a tester's write-up
      // isn't a gate, so its own failure just means no write-up, not a stuck task.
      let testingNotes: string | undefined;
      if (config.testingNotes) {
        config.onIteration?.({ iteration: i + 1, phase: "writing_testing_notes", costUsd: totalCostUsd, summary: "Пишу инструкцию для тестировщика" });
        const notesResult = await generateTestingNotes(worktreeDir, task, config.testingNotes);
        totalCostUsd += notesResult.costUsd;
        testingNotes = notesResult.notes;
        if (notesResult.reason) config.onLog?.(`⚠️ Не удалось сгенерировать инструкцию для тестировщика (${notesResult.reason})`);
      }

      let memoryUpdated = false;
      if (config.memory) {
        config.onIteration?.({ iteration: i + 1, phase: "updating_memory", costUsd: totalCostUsd, summary: "Обновляю project memory" });
        const memResult = await updateProjectMemory(worktreeDir, task, config.memory);
        totalCostUsd += memResult.costUsd;
        memoryUpdated = memResult.updated;
        if (memResult.reason) config.onLog?.(`⚠️ Не удалось обновить project memory (${memResult.reason})`);
      }

      return {
        task,
        success: true,
        iterations,
        totalCostUsd,
        stopReason: "verified",
        worktreeDir,
        acceptanceTestPath,
        memoryUpdated,
        reviewFindings,
        testingNotes,
      };
    }

    // A resumed session's quality degrades well before this hits the model's hard
    // window limit, and there is no proven-safe way yet to hand off to a fresh session
    // mid-task without losing what the agent already knows — so this stops and asks a
    // human, the same answer the loop already gives for max_iterations/max_budget/stuck.
    const contextTokens = totalContextTokens(turn.usage);
    if (config.maxContextTokens && contextTokens >= config.maxContextTokens) {
      return {
        task,
        success: false,
        iterations,
        totalCostUsd,
        stopReason: "context_budget",
        worktreeDir,
        acceptanceTestPath,
        contextTokens,
      };
    }

    const failedGates = verify.gates.filter((g) => !g.passed);
    const fingerprint = fingerprintFailure(failedGates);
    if (fingerprint === previousFingerprint) {
      return {
        task,
        success: false,
        iterations,
        totalCostUsd,
        stopReason: "stuck",
        worktreeDir,
        acceptanceTestPath,
        stuckGates: failedGates.map((g) => g.name),
      };
    }
    previousFingerprint = fingerprint;

    prompt = buildFeedbackPrompt(failedGates);
  }

  return { task, success: false, iterations, totalCostUsd, stopReason: "max_iterations", worktreeDir, acceptanceTestPath };
}
