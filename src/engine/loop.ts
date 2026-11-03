import type { CloseLoopIteration, CloseLoopResult, EngineConfig, GateSpec, TaskSpec } from "../types.js";
import { runClaudeTurn } from "./claudeEngine.js";
import { establishBaselines, runGates } from "./verify.js";
import { buildFeedbackPrompt, buildInitialPrompt } from "./prompts.js";
import { createWorktree, commitAll } from "./git.js";
import { writeAcceptanceTest } from "./acceptanceTest.js";

export async function runCloseLoop(task: TaskSpec, config: EngineConfig): Promise<CloseLoopResult> {
  const worktreeDir = await createWorktree(config.repoPath, config.branchName);

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

  const iterations: CloseLoopIteration[] = [];
  let prompt = buildInitialPrompt(task);
  let resumeSessionId: string | undefined;

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
      return { task, success: true, iterations, totalCostUsd, stopReason: "verified", worktreeDir, acceptanceTestPath };
    }

    prompt = buildFeedbackPrompt(verify.gates.filter((g) => !g.passed));
  }

  return { task, success: false, iterations, totalCostUsd, stopReason: "max_iterations", worktreeDir, acceptanceTestPath };
}
