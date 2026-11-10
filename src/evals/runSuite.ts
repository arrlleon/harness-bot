import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { HARNESS_STATE_DIR } from "../bot/liveState.js";
import { loadEvalCase, loadAllEvalCases } from "./loadCases.js";
import { runEvalCase } from "./runCase.js";
import type { EvalCase, EvalCaseAggregate, EvalCaseResult, EvalSuiteResult } from "./types.js";
import type { RepoConfig } from "../config.js";

export interface RunEvalSuiteOptions {
  repos: Record<string, RepoConfig>;
  model: string;
  maxIterations: number;
  maxBudgetUsd: number;
  // Repeats per case. Default 1, for exact backward compatibility (every existing
  // caller that never passed k keeps running each case exactly once).
  k?: number;
  onCaseStart?: (caseId: string) => void;
  // Fires after each individual attempt — the live progress signal while a case is
  // still running its k repeats.
  onAttemptDone?: (caseId: string, attemptIndex: number, k: number, result: EvalCaseResult) => void;
  // Fires once per case, after all k attempts — the aggregate a report is built from.
  onCaseDone?: (aggregate: EvalCaseAggregate) => void;
}

export function average(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

// Pure: turns a case's k attempt results into the pass@1/pass^k numbers a report reads.
// Separated from runCaseKTimes below so this math is testable without actually running
// an eval case (real git worktrees + a real `claude` turn).
//
// Found, not yet fixed, in an earlier audit: an empty `attempts` array (k=0, a negative
// k, or NaN from a bad `--k` CLI value all reduce to this, since runCaseKTimes's loop
// just never runs) silently reported a false PASS — average([]) is NaN, and
// [].every(...) is vacuously true, so a case that never ran at all looked identical to
// one that passed every attempt. Throwing here, rather than degrading quietly, is the
// same reasoning as cli.ts's own k validation below: zero evidence must never render as
// a report.
export function aggregateAttempts(caseId: string, attempts: EvalCaseResult[]): EvalCaseAggregate {
  if (attempts.length === 0) {
    throw new Error(`aggregateAttempts(${caseId}): no attempts to aggregate — refusing to report a false pass over zero runs`);
  }
  return {
    caseId,
    attempts,
    passAtOneRate: average(attempts.map((a) => (a.passed ? 1 : 0))),
    passAtK: attempts.every((a) => a.passed),
    totalCostUsd: attempts.reduce((sum, a) => sum + a.costUsd, 0),
  };
}

async function runCaseKTimes(
  evalCase: EvalCase,
  k: number,
  runOpts: Parameters<typeof runEvalCase>[1],
  onAttemptDone: RunEvalSuiteOptions["onAttemptDone"],
): Promise<EvalCaseAggregate> {
  const attempts: EvalCaseResult[] = [];
  for (let i = 0; i < k; i++) {
    const result = await runEvalCase(evalCase, runOpts);
    attempts.push(result);
    onAttemptDone?.(evalCase.id, i + 1, k, result);
  }
  return aggregateAttempts(evalCase.id, attempts);
}

const RUNS_DIR = join(HARNESS_STATE_DIR, "eval-runs");

async function saveRun(result: EvalSuiteResult): Promise<string> {
  await mkdir(RUNS_DIR, { recursive: true });
  const path = join(RUNS_DIR, `${result.runAt.replace(/[:.]/g, "-")}.json`);
  await writeFile(path, JSON.stringify(result, null, 2));
  return path;
}

// Sequential, deliberately — not parallel. Running back-ai and front-ai cases at the
// same time would double the memory pressure that already OOM-killed this machine
// twice this session on a single full test-suite run; cases are meant to be cheap and
// safe to run often, not fast at the cost of flakiness.
export async function runEvalSuite(caseIds: string[] | undefined, opts: RunEvalSuiteOptions): Promise<{ result: EvalSuiteResult; savedTo: string }> {
  const cases = caseIds && caseIds.length > 0 ? await Promise.all(caseIds.map(loadEvalCase)) : await loadAllEvalCases();
  const k = opts.k ?? 1;

  const aggregates: EvalCaseAggregate[] = [];
  for (const evalCase of cases) {
    opts.onCaseStart?.(evalCase.id);
    const repo = opts.repos[evalCase.repo];
    if (!repo?.path) {
      // Still shaped as a (single, failed) attempt — a report built from this suite
      // shouldn't need a separate code path for "never even ran" vs. "ran and failed".
      const failure: EvalCaseResult = {
        caseId: evalCase.id,
        passed: false,
        stopReason: `repo "${evalCase.repo}" not configured (missing *_REPO_PATH)`,
        costUsd: 0,
        iterations: 0,
        hiddenTestPassed: false,
        gateResults: [],
        durationMs: 0,
      };
      const aggregate = aggregateAttempts(evalCase.id, [failure]);
      aggregates.push(aggregate);
      opts.onCaseDone?.(aggregate);
      continue;
    }
    const aggregate = await runCaseKTimes(
      evalCase,
      k,
      {
        repoPath: repo.path,
        model: opts.model,
        maxIterations: opts.maxIterations,
        maxBudgetUsd: opts.maxBudgetUsd,
        acceptanceRunner: repo.acceptanceRunner,
        repoGates: repo.gates,
      },
      opts.onAttemptDone,
    );
    aggregates.push(aggregate);
    opts.onCaseDone?.(aggregate);
  }

  const suiteResult: EvalSuiteResult = {
    runAt: new Date().toISOString(),
    model: opts.model,
    k,
    cases: aggregates,
    passAtOneRate: average(aggregates.map((a) => a.passAtOneRate)),
    passAtKCount: aggregates.filter((a) => a.passAtK).length,
    totalCount: aggregates.length,
    totalCostUsd: aggregates.reduce((sum, a) => sum + a.totalCostUsd, 0),
  };
  const savedTo = await saveRun(suiteResult);
  return { result: suiteResult, savedTo };
}
