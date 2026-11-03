import type { CloseLoopIteration, CloseLoopResult, EngineConfig, TaskSpec } from "../types.js";
import { runClaudeTurn } from "./claudeEngine.js";
import { establishBaselines, runGates } from "./verify.js";
import { buildFeedbackPrompt, buildInitialPrompt } from "./prompts.js";
import { createWorktree, commitAll } from "./git.js";

export async function runCloseLoop(task: TaskSpec, config: EngineConfig): Promise<CloseLoopResult> {
  const worktreeDir = await createWorktree(config.repoPath, config.branchName);

  // Can take minutes on a real test suite — say so up front, same reasoning as the
  // analyzing-turn message: a long silent gap here reads as "stuck", not "working".
  const gateNames = config.gates.map((g) => g.name).join(", ");
  config.onIteration?.({ iteration: 0, phase: "baseline", costUsd: 0, summary: `Считаю baseline по гейтам: ${gateNames}` });
  const baselines = await establishBaselines(worktreeDir, config.gates);

  const iterations: CloseLoopIteration[] = [];
  let totalCostUsd = 0;
  let prompt = buildInitialPrompt(task);
  let resumeSessionId: string | undefined;

  for (let i = 0; i < config.maxIterations; i++) {
    const remainingBudget = config.maxBudgetUsd - totalCostUsd;
    if (remainingBudget <= 0) {
      return { task, success: false, iterations, totalCostUsd, stopReason: "max_budget", worktreeDir };
    }

    const turn = await runClaudeTurn({
      cwd: worktreeDir,
      prompt,
      permissionMode: config.permissionMode,
      resumeSessionId,
      maxBudgetUsd: remainingBudget,
      extraDeniedPaths: config.extraDeniedPaths,
      model: config.model,
      onLog: config.onLog,
    });
    totalCostUsd += turn.totalCostUsd;
    resumeSessionId = turn.sessionId;
    config.onIteration?.({ iteration: i + 1, phase: "iterating", costUsd: totalCostUsd, summary: turn.resultText.slice(0, 200) });

    if (turn.isError) {
      iterations.push({ turn, verify: { passed: false, output: turn.resultText, gates: [] } });
      return { task, success: false, iterations, totalCostUsd, stopReason: "agent_error", worktreeDir };
    }

    config.onIteration?.({ iteration: i + 1, phase: "verifying", costUsd: totalCostUsd, summary: turn.resultText.slice(0, 200) });
    const verify = await runGates(worktreeDir, config.gates, baselines);
    iterations.push({ turn, verify });

    if (verify.passed) {
      await commitAll(worktreeDir, `${task.id}: ${task.title}\n\nAutomated by jira-harness.`);
      return { task, success: true, iterations, totalCostUsd, stopReason: "verified", worktreeDir };
    }

    prompt = buildFeedbackPrompt(verify.gates.filter((g) => !g.passed));
  }

  return { task, success: false, iterations, totalCostUsd, stopReason: "max_iterations", worktreeDir };
}
