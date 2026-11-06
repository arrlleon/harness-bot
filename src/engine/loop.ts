import type {
  ClaudeTurnUsage,
  CloseLoopIteration,
  CloseLoopResult,
  EngineConfig,
  GateBaseline,
  GateSpec,
  ReviewFinding,
  TaskSpec,
} from "../types.js";
import { runClaudeTurn } from "./claudeEngine.js";
import { establishBaselines, runGates } from "./verify.js";
import { buildFeedbackPrompt, buildInitialPrompt } from "./prompts.js";
import { createWorktree, commitAll, fetchFreshBase, rebaseOntoFreshBase } from "./git.js";
import { writeAcceptanceTest } from "./acceptanceTest.js";
import { readMemoryFiles, buildMemoryContextBlock, updateProjectMemory } from "./memory.js";
import { fingerprintFailure } from "./stuckDetector.js";
import { reviewChanges, buildReviewFixPrompt, formatReviewRound } from "./review.js";
import { generateTestingNotes } from "./testingNotes.js";
import { checkGateIntegrity } from "./gateIntegrity.js";
import { writeTaskContext } from "./agentContext.js";
import { parseBrief } from "./brief.js";

// input + cache_read + cache_creation is the real total context the model saw this
// turn, not a per-turn delta — confirmed empirically elsewhere (a turn can report
// input_tokens in the single digits while the real context is in the tens of
// thousands, almost all of it served from cache).
export function totalContextTokens(usage: ClaudeTurnUsage): number {
  return usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
}

// Everything that runs once the implement loop has a real, committed success: gate
// integrity, the independent review<->fix loop, testing notes, project memory. Entered
// two ways: normally, right after the main loop's own success (startRound/resumingFix
// absent), or resuming a brief the review-fix turn itself raised (skipGateIntegrityCheck
// true — it already ran before the pause — and resumingFix set to finish that one fix
// turn with the human's answer before continuing the review loop from the next round).
async function runPostImplementSuccess(
  task: TaskSpec,
  worktreeDir: string,
  config: EngineConfig,
  ctx: {
    iterations: CloseLoopIteration[];
    totalCostUsd: number;
    resumeSessionId: string;
    gates: GateSpec[];
    baselines: GateBaseline[];
    extraDeniedPaths?: string[];
    acceptanceTestPath?: string;
    skipGateIntegrityCheck: boolean;
    resumingFix?: { round: number; blocking: ReviewFinding[]; prompt: string };
  },
): Promise<CloseLoopResult> {
  const { iterations, gates, baselines, extraDeniedPaths, acceptanceTestPath } = ctx;
  let totalCostUsd = ctx.totalCostUsd;
  let resumeSessionId = ctx.resumeSessionId;

  // Runs before review/memory/testing-notes and short-circuits on a hit — if the
  // agent earned "green" by weakening the judge rather than fixing the bug, there's
  // no point spending an LLM turn reviewing that diff, and no retry: unlike a
  // normal gate failure, giving it another attempt just risks it hiding this better.
  if (!ctx.skipGateIntegrityCheck && config.gateIntegrityCheck) {
    config.onIteration?.({
      iteration: iterations.length,
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
  //
  // A blocking finding doesn't go straight to a human anymore: it's handed back to
  // the SAME implement session (resumeSessionId, so it remembers what it already
  // did) as a fix request, gates re-run, reviewer looks again — same loop shape as
  // gate feedback, just with the reviewer in place of a failing gate. Capped at
  // config.review.maxRounds: two agents negotiating with each other need a hard
  // stop the same way maxIterations is one for the gate-fixing loop, or a pair that
  // never agrees burns the whole budget arguing. Every round is written to
  // .harness-state/tasks/<task.id>/{reviewer,dev}/ — a human reading the eventual
  // needs_human case sees the actual back-and-forth, not just the final verdict.
  let reviewFindings: ReviewFinding[] | undefined;
  let reviewRounds = 0;
  if (config.review) {
    for (let round = ctx.resumingFix?.round ?? 1; round <= config.review.maxRounds; round++) {
      reviewRounds = round;
      let blocking: ReviewFinding[];
      let fixPrompt: string;

      if (ctx.resumingFix && round === ctx.resumingFix.round) {
        // Resuming: the diff hasn't changed since this round's blocking findings were
        // raised and the fix turn paused on a brief instead of acting on them — re-
        // running reviewChanges here would just repeat the same findings for no reason.
        blocking = ctx.resumingFix.blocking;
        fixPrompt = ctx.resumingFix.prompt;
      } else {
        config.onIteration?.({
          iteration: iterations.length,
          phase: "reviewing",
          costUsd: totalCostUsd,
          summary: `Ревьюю изменения (раунд ${round}/${config.review.maxRounds})`,
        });
        const reviewResult = await reviewChanges(worktreeDir, task, config.review);
        totalCostUsd += reviewResult.costUsd;
        reviewFindings = reviewResult.findings;
        if (reviewResult.reason) config.onLog?.(`⚠️ Не удалось провести ревью (${reviewResult.reason})`);
        writeTaskContext(task.id, "reviewer", `round-${round}.md`, formatReviewRound(reviewFindings, reviewResult.reason));

        blocking = reviewFindings.filter((f) => f.blocking);
        if (blocking.length === 0) break; // ревьюер доволен

        if (round === config.review.maxRounds) {
          return {
            task,
            success: false,
            iterations,
            totalCostUsd,
            stopReason: "review_blocked",
            worktreeDir,
            acceptanceTestPath,
            reviewFindings,
            reviewRounds,
          };
        }

        fixPrompt = buildReviewFixPrompt(blocking);
      }

      const remainingBudget = config.maxBudgetUsd - totalCostUsd;
      if (remainingBudget <= 0) {
        return { task, success: false, iterations, totalCostUsd, stopReason: "max_budget", worktreeDir, acceptanceTestPath };
      }

      config.onIteration?.({
        iteration: iterations.length,
        phase: "iterating",
        costUsd: totalCostUsd,
        summary: `Правлю по замечаниям ревьюера (раунд ${round})`,
      });
      const fixTurn = await runClaudeTurn({
        cwd: worktreeDir,
        prompt: fixPrompt,
        permissionMode: config.permissionMode,
        resumeSessionId,
        maxBudgetUsd: remainingBudget,
        extraDeniedPaths,
        model: config.model,
        onLog: config.onLog,
      });
      totalCostUsd += fixTurn.totalCostUsd;
      resumeSessionId = fixTurn.sessionId;
      writeTaskContext(task.id, "dev", `round-${round}-response.md`, fixTurn.resultText);

      // Same brief support as the main implement loop — the fix turn is just another
      // implement turn, and the human's answer can itself raise ANOTHER question.
      const brief = config.briefsEnabled !== false ? parseBrief(fixTurn.resultText) : null;
      if (brief) {
        iterations.push({ turn: fixTurn, verify: { passed: false, output: fixTurn.resultText, gates: [] } });
        return {
          task,
          success: false,
          iterations,
          totalCostUsd,
          stopReason: "brief_pending",
          worktreeDir,
          acceptanceTestPath,
          brief,
          resumeState: {
            sessionId: resumeSessionId,
            worktreeDir,
            iteration: iterations.length,
            totalCostUsd,
            gates,
            baselines,
            extraDeniedPaths,
            acceptanceTestPath,
            reviewResume: { round, blocking },
          },
        };
      }

      if (fixTurn.isError) {
        iterations.push({ turn: fixTurn, verify: { passed: false, output: fixTurn.resultText, gates: [] } });
        return { task, success: false, iterations, totalCostUsd, stopReason: "agent_error", worktreeDir, acceptanceTestPath };
      }

      const fixVerify = await runGates(worktreeDir, gates, baselines);
      iterations.push({ turn: fixTurn, verify: fixVerify });
      if (!fixVerify.passed) {
        // The review-fix attempt broke a gate — rather than nest a whole second
        // gate-fixing loop inside the review loop, stop here with a clear reason;
        // a human has more context to judge this than another blind retry would.
        return {
          task,
          success: false,
          iterations,
          totalCostUsd,
          stopReason: "review_blocked",
          worktreeDir,
          acceptanceTestPath,
          reviewFindings: [
            ...blocking,
            { blocking: true, description: "правка по замечаниям ревью сломала гейты — см. последнюю итерацию" },
          ],
          reviewRounds,
        };
      }
      await commitAll(worktreeDir, `${task.id}: fix review round ${round}\n\nAutomated by jira-harness.`);
    }
  }

  // Purely informational, never blocking (unlike review) — a tester's write-up
  // isn't a gate, so its own failure just means no write-up, not a stuck task.
  let testingNotes: string | undefined;
  if (config.testingNotes) {
    config.onIteration?.({ iteration: iterations.length, phase: "writing_testing_notes", costUsd: totalCostUsd, summary: "Пишу инструкцию для тестировщика" });
    const notesResult = await generateTestingNotes(worktreeDir, task, config.testingNotes);
    totalCostUsd += notesResult.costUsd;
    testingNotes = notesResult.notes;
    if (notesResult.reason) config.onLog?.(`⚠️ Не удалось сгенерировать инструкцию для тестировщика (${notesResult.reason})`);
  }

  let memoryUpdated = false;
  if (config.memory) {
    config.onIteration?.({ iteration: iterations.length, phase: "updating_memory", costUsd: totalCostUsd, summary: "Обновляю project memory" });
    const memResult = await updateProjectMemory(worktreeDir, task, { ...config.memory, role: "dev" });
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
    reviewRounds: config.review ? reviewRounds : undefined,
    testingNotes,
  };
}

export async function runCloseLoop(task: TaskSpec, config: EngineConfig): Promise<CloseLoopResult> {
  // config.resumeFrom?.worktreeDir takes priority: resuming a brief (main loop, review
  // round, or cross-repo) must reuse the exact worktree the paused session's
  // uncommitted work is sitting in. createWorktree() force-removes and recreates
  // whatever's already registered at that path (see git.ts and CloseLoopResumeState's
  // own comment) — calling it again here would silently discard that work before the
  // resumed turn even runs. config.existingWorktreeDir is the other, unrelated reason
  // to skip creating a worktree: the eval harness (runCase.ts) pins one to a specific
  // historical commit up front. Only a genuinely new task reaches createWorktree() at
  // all, which is also the only case fetching a fresh base point makes sense — a
  // worktree with no commits of its own has nothing to rebase.
  const worktreeDir =
    config.resumeFrom?.worktreeDir ??
    config.existingWorktreeDir ??
    (await createWorktree(
      config.repoPath,
      config.branchName,
      config.freshBase ? await fetchFreshBase(config.repoPath, config.freshBase.baseBranch) : undefined,
    ));

  // A resume (any of the three kinds) can have sat paused for hours or days waiting on
  // a human — long enough for dev to move well past where this worktree started.
  // Rebasing here, once, right as work picks back up, is the resume-side half of
  // fetchFreshBase above: that one only ever runs once, at a brand-new task's very
  // start, with nothing of its own yet to replay. On conflict, stop immediately and
  // escalate — same reasoning as a review-fix round breaking a gate: a human has more
  // context to resolve a real conflict than another blind retry would, and the
  // worktree is already back in its clean pre-rebase state (rebaseOntoFreshBase aborts
  // on failure), so nothing here is left half-done.
  if (config.resumeFrom && config.freshBase) {
    const rebase = await rebaseOntoFreshBase(worktreeDir, config.freshBase.baseBranch);
    if (rebase.conflict) {
      return {
        task,
        success: false,
        iterations: [],
        totalCostUsd: config.resumeFrom.totalCostUsd,
        stopReason: "rebase_conflict",
        worktreeDir,
        acceptanceTestPath: config.resumeFrom.acceptanceTestPath,
        rebaseConflictOutput: rebase.output,
      };
    }
  }

  // Resuming a brief raised during the review<->fix loop's own fix turn — the main
  // implement loop, acceptance test, baseline, and gate-integrity check already ran
  // and succeeded before the pause. Nothing above to redo; continue exactly where the
  // review loop paused, with the human's answer as this round's fix turn.
  const reviewResume = config.resumeFrom?.reviewResume;
  if (reviewResume) {
    const rf = config.resumeFrom!;
    return runPostImplementSuccess(task, worktreeDir, config, {
      iterations: [],
      totalCostUsd: rf.totalCostUsd,
      resumeSessionId: rf.sessionId,
      gates: rf.gates,
      baselines: rf.baselines,
      extraDeniedPaths: rf.extraDeniedPaths,
      acceptanceTestPath: rf.acceptanceTestPath,
      skipGateIntegrityCheck: true,
      resumingFix: { round: reviewResume.round, blocking: reviewResume.blocking, prompt: rf.prompt },
    });
  }

  let totalCostUsd: number;
  let gates: GateSpec[];
  let extraDeniedPaths: string[] | undefined;
  let acceptanceTestPath: string | undefined;
  let baselines: GateBaseline[];
  let prompt: string;
  let resumeSessionId: string | undefined;
  // Set once a failure happens, compared against the NEXT failure — not the error
  // itself but whether the agent's last edit changed anything about its *nature*.
  // Needs two failed iterations to ever trigger, so a single bad attempt never does.
  let previousFingerprint: string | undefined;
  let startIteration: number;

  if (config.resumeFrom) {
    // Resuming after a human answered a brief (see parseBrief below) — everything in
    // the `else` branch already ran before the pause. Redoing it would re-establish
    // baselines against a worktree that already has partial work in it (wrong) and
    // risk writing a second, conflicting acceptance test.
    totalCostUsd = config.resumeFrom.totalCostUsd;
    gates = config.resumeFrom.gates;
    extraDeniedPaths = config.resumeFrom.extraDeniedPaths;
    acceptanceTestPath = config.resumeFrom.acceptanceTestPath;
    baselines = config.resumeFrom.baselines;
    prompt = config.resumeFrom.prompt;
    resumeSessionId = config.resumeFrom.sessionId;
    previousFingerprint = config.resumeFrom.previousFingerprint;
    startIteration = config.resumeFrom.iteration;
  } else {
    totalCostUsd = 0;
    gates = config.gates;
    extraDeniedPaths = config.extraDeniedPaths;

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
    baselines = await establishBaselines(worktreeDir, gates);

    // Read-only context, injected directly rather than left for the agent to stumble
    // onto — the project's own CLAUDE.md only auto-loads AGENTS.md, not memory files.
    // "dev" — this is the implement role's own memory, separate from pm's/reviewer's.
    const memories = await readMemoryFiles(config.repoPath, "dev");
    const memoryContext = buildMemoryContextBlock(memories, "dev");
    prompt = buildInitialPrompt(task, memoryContext, config.briefsEnabled !== false);
    startIteration = 0;
  }

  const iterations: CloseLoopIteration[] = [];

  for (let i = startIteration; i < config.maxIterations; i++) {
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

    // Checked before isError/gates — a brief means the agent deliberately made no
    // (further) changes this turn rather than guess, so there's nothing to verify yet.
    // Only supported here, in the main implement turn — not inside the review-fix
    // loop below, where "which review round we were mid-way through" would also need
    // to survive the pause; narrower but correctly resumable beats broader but subtly
    // wrong. resumeSessionId is already this turn's session (set just above), so
    // resuming continues the exact conversation the agent paused mid-way through.
    const brief = config.briefsEnabled !== false ? parseBrief(turn.resultText) : null;
    if (brief) {
      iterations.push({ turn, verify: { passed: false, output: turn.resultText, gates: [] } });
      return {
        task,
        success: false,
        iterations,
        totalCostUsd,
        stopReason: "brief_pending",
        worktreeDir,
        acceptanceTestPath,
        brief,
        resumeState: { sessionId: resumeSessionId, worktreeDir, iteration: i, totalCostUsd, gates, baselines, extraDeniedPaths, acceptanceTestPath, previousFingerprint },
      };
    }

    if (turn.isError) {
      iterations.push({ turn, verify: { passed: false, output: turn.resultText, gates: [] } });
      return { task, success: false, iterations, totalCostUsd, stopReason: "agent_error", worktreeDir, acceptanceTestPath };
    }

    config.onIteration?.({ iteration: i + 1, phase: "verifying", costUsd: totalCostUsd, summary: turn.resultText.slice(0, 200) });
    const verify = await runGates(worktreeDir, gates, baselines);
    iterations.push({ turn, verify });

    if (verify.passed) {
      await commitAll(worktreeDir, `${task.id}: ${task.title}\n\nAutomated by jira-harness.`);
      return runPostImplementSuccess(task, worktreeDir, config, {
        iterations,
        totalCostUsd,
        resumeSessionId,
        gates,
        baselines,
        extraDeniedPaths,
        acceptanceTestPath,
        skipGateIntegrityCheck: false,
      });
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
