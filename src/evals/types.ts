export interface EvalCase {
  id: string;
  title: string;
  description: string;
  repo: "backend" | "frontend";
  baseCommit: string;
  referenceCommit: string;
  // Real test file(s) from the historical fix commit, restored into the worktree at
  // baseCommit before the agent ever starts — the "hidden test" an agent can't see
  // until it's already gating its own iterations, same spirit as production's
  // acceptance-test layer, except this one is a real historical answer, not generated
  // per run (deliberately, for reproducible comparisons across harness changes).
  hiddenTestPaths: string[];
}

export interface EvalCaseResult {
  caseId: string;
  passed: boolean;
  stopReason: string;
  costUsd: number;
  iterations: number;
  // Specifically whether the historical hidden test passed, even when the case
  // overall didn't (e.g. stuck on typecheck while already satisfying the real fix,
  // or vice versa) — lets a report distinguish "wrong fix" from "right fix, messy gate".
  hiddenTestPassed: boolean;
  gateResults: { name: string; passed: boolean }[];
  durationMs: number;
}

export interface EvalSuiteResult {
  runAt: string;
  model: string;
  cases: EvalCaseResult[];
  passCount: number;
  totalCount: number;
  totalCostUsd: number;
}
