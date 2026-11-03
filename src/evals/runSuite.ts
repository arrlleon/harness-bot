import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { HARNESS_STATE_DIR } from "../bot/liveState.js";
import { loadEvalCase, loadAllEvalCases } from "./loadCases.js";
import { runEvalCase } from "./runCase.js";
import type { EvalCaseResult, EvalSuiteResult } from "./types.js";
import type { RepoConfig } from "../config.js";

export interface RunEvalSuiteOptions {
  repos: Record<string, RepoConfig>;
  model: string;
  maxIterations: number;
  maxBudgetUsd: number;
  onCaseStart?: (caseId: string) => void;
  onCaseDone?: (result: EvalCaseResult) => void;
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

  const results: EvalCaseResult[] = [];
  for (const evalCase of cases) {
    opts.onCaseStart?.(evalCase.id);
    const repo = opts.repos[evalCase.repo];
    if (!repo?.path) {
      results.push({
        caseId: evalCase.id,
        passed: false,
        stopReason: `repo "${evalCase.repo}" not configured (missing *_REPO_PATH)`,
        costUsd: 0,
        iterations: 0,
        hiddenTestPassed: false,
        gateResults: [],
        durationMs: 0,
      });
      continue;
    }
    const result = await runEvalCase(evalCase, {
      repoPath: repo.path,
      model: opts.model,
      maxIterations: opts.maxIterations,
      maxBudgetUsd: opts.maxBudgetUsd,
      acceptanceRunner: repo.acceptanceRunner,
      repoGates: repo.gates,
    });
    results.push(result);
    opts.onCaseDone?.(result);
  }

  const suiteResult: EvalSuiteResult = {
    runAt: new Date().toISOString(),
    model: opts.model,
    cases: results,
    passCount: results.filter((r) => r.passed).length,
    totalCount: results.length,
    totalCostUsd: results.reduce((sum, r) => sum + r.costUsd, 0),
  };
  const savedTo = await saveRun(suiteResult);
  return { result: suiteResult, savedTo };
}
