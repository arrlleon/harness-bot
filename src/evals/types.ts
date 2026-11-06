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

// One case run k times — a single attempt is just noise (an agent is non-deterministic,
// and 15 cases at k=1 already made ±3pp indistinguishable from chance). Grouping by
// case rather than flattening every attempt into one list is what makes both pass@1
// and pass^k computable per case, not just across the whole suite.
export interface EvalCaseAggregate {
  caseId: string;
  attempts: EvalCaseResult[];
  // Mean pass rate across the k attempts — e.g. 2 of 3 passing is 0.666....
  passAtOneRate: number;
  // Stricter than passAtOneRate: true only if EVERY attempt passed. The number that
  // actually matters for a harness meant to run unattended — "passes about 2 times out
  // of 3" still means roughly one run in three needed a human, which an average alone
  // hides. Same vocabulary/reasoning as Avengers Harness's own eval design.
  passAtK: boolean;
  totalCostUsd: number;
}

export interface EvalSuiteResult {
  runAt: string;
  model: string;
  // How many times each case was run. 1 preserves the exact old single-attempt shape
  // (passAtOneRate is then just 0 or 1, passAtK equals the one attempt's own result).
  k: number;
  cases: EvalCaseAggregate[];
  // Mean of each case's own passAtOneRate — not "attempts passed / total attempts" —
  // so a case that happened to run fewer times never silently outweighs the others.
  passAtOneRate: number;
  // Count of cases where every attempt passed, out of totalCount cases.
  passAtKCount: number;
  totalCount: number;
  totalCostUsd: number;
}
