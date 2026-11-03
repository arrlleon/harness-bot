import { randomUUID } from "node:crypto";
import { createWorktree, removeWorktree, deleteBranch, restorePathsFromCommit, commitAll } from "../engine/git.js";
import { runCloseLoop } from "../engine/loop.js";
import { buildEvalGates } from "./gates.js";
import type { EvalCase, EvalCaseResult } from "./types.js";
import type { GateSpec, TaskSpec } from "../types.js";

export interface RunEvalCaseOptions {
  repoPath: string;
  model: string;
  maxIterations: number;
  maxBudgetUsd: number;
  acceptanceRunner: string;
  repoGates: GateSpec[];
  onLog?: (line: string) => void;
}

// Runs one historical bug through the real production pipeline (runCloseLoop,
// unmodified) with two deliberate differences from a live task: the worktree starts
// at the bug's actual baseCommit instead of HEAD, and the "acceptance test" is the
// real historical test restored from the fix commit instead of one generated fresh —
// fixed and reproducible, so two eval runs are actually comparable to each other.
//
// No acceptanceTest/memory config: the hidden test already plays the acceptance-test
// role, and an eval run must never write into the project's real project-memory file.
export async function runEvalCase(evalCase: EvalCase, opts: RunEvalCaseOptions): Promise<EvalCaseResult> {
  const startedAt = Date.now();
  const branchName = `eval/${evalCase.id.toLowerCase()}-${randomUUID().slice(0, 8)}`;
  const task: TaskSpec = { id: evalCase.id, title: evalCase.title, description: evalCase.description, acceptanceCriteria: [] };

  const worktreeDir = await createWorktree(opts.repoPath, branchName, evalCase.baseCommit);

  try {
    // Staged and committed up front — same reasoning as writeAcceptanceTest: the
    // hidden test has to exist before the loop's own baseline runs, so its strict gate
    // correctly observes "fails at baseline" (no fix yet) rather than "file not found".
    await restorePathsFromCommit(worktreeDir, evalCase.referenceCommit, evalCase.hiddenTestPaths);
    await commitAll(worktreeDir, `eval(${evalCase.id}): stage hidden test from ${evalCase.referenceCommit.slice(0, 12)}`);

    const gates = buildEvalGates(opts.repoGates, opts.acceptanceRunner, evalCase.hiddenTestPaths);

    const result = await runCloseLoop(task, {
      repoPath: opts.repoPath,
      branchName,
      existingWorktreeDir: worktreeDir,
      gates,
      maxIterations: opts.maxIterations,
      maxBudgetUsd: opts.maxBudgetUsd,
      permissionMode: "acceptEdits",
      model: opts.model,
      onLog: opts.onLog,
    });

    const lastGates = result.iterations.at(-1)?.verify.gates ?? [];
    const hiddenGateResult = lastGates.find((g) => g.name === "hidden_test");

    return {
      caseId: evalCase.id,
      passed: result.success,
      stopReason: result.stopReason,
      costUsd: result.totalCostUsd,
      iterations: result.iterations.length,
      hiddenTestPassed: result.success || (hiddenGateResult?.passed ?? false),
      gateResults: lastGates.map((g) => ({ name: g.name, passed: g.passed })),
      durationMs: Date.now() - startedAt,
    };
  } finally {
    await removeWorktree(opts.repoPath, worktreeDir).catch(() => {});
    await deleteBranch(opts.repoPath, branchName);
  }
}
