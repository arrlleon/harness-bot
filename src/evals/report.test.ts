import { test } from "node:test";
import assert from "node:assert/strict";
import { formatSuiteReport } from "./report.js";
import type { EvalSuiteResult } from "./types.js";

test("formatSuiteReport at k=1 includes every case, its status, cost, and gate breakdown", () => {
  const result: EvalSuiteResult = {
    runAt: "2026-11-03T12:00:00.000Z",
    model: "claude-opus-5",
    k: 1,
    cases: [
      {
        caseId: "XEN-364",
        passAtOneRate: 1,
        passAtK: true,
        totalCostUsd: 1.2345,
        attempts: [
          {
            caseId: "XEN-364",
            passed: true,
            stopReason: "verified",
            costUsd: 1.2345,
            iterations: 2,
            hiddenTestPassed: true,
            gateResults: [
              { name: "typecheck", passed: true },
              { name: "hidden_test", passed: true },
            ],
            durationMs: 42000,
          },
        ],
      },
      {
        caseId: "XEN-369",
        passAtOneRate: 0,
        passAtK: false,
        totalCostUsd: 0.5,
        attempts: [
          {
            caseId: "XEN-369",
            passed: false,
            stopReason: "stuck",
            costUsd: 0.5,
            iterations: 2,
            hiddenTestPassed: false,
            gateResults: [{ name: "hidden_test", passed: false }],
            durationMs: 15000,
          },
        ],
      },
    ],
    passAtOneRate: 0.5,
    passAtKCount: 1,
    totalCount: 2,
    totalCostUsd: 1.7345,
  };

  const report = formatSuiteReport(result);
  assert.match(report, /PASS/);
  assert.match(report, /XEN-364/);
  assert.match(report, /FAIL/);
  assert.match(report, /XEN-369/);
  assert.match(report, /hidden_test:FAIL/);
  assert.match(report, /1\/2 passed/);
  assert.match(report, /claude-opus-5/);
  assert.match(report, /\$1\.7345/);
});

test("formatSuiteReport handles a case with no gate results at all (e.g. repo not configured)", () => {
  const result: EvalSuiteResult = {
    runAt: "2026-11-03T12:00:00.000Z",
    model: "claude-opus-5",
    k: 1,
    cases: [
      {
        caseId: "XEN-302",
        passAtOneRate: 0,
        passAtK: false,
        totalCostUsd: 0,
        attempts: [
          {
            caseId: "XEN-302",
            passed: false,
            stopReason: 'repo "frontend" not configured',
            costUsd: 0,
            iterations: 0,
            hiddenTestPassed: false,
            gateResults: [],
            durationMs: 0,
          },
        ],
      },
    ],
    passAtOneRate: 0,
    passAtKCount: 0,
    totalCount: 1,
    totalCostUsd: 0,
  };
  const report = formatSuiteReport(result);
  assert.match(report, /\(none ran\)/);
});

test("formatSuiteReport at k>1 shows pass@1/pass^k per case and in the summary, with each attempt listed", () => {
  const result: EvalSuiteResult = {
    runAt: "2026-11-03T12:00:00.000Z",
    model: "claude-opus-5",
    k: 3,
    cases: [
      {
        caseId: "XEN-364",
        passAtOneRate: 2 / 3,
        passAtK: false, // one of the three attempts failed
        totalCostUsd: 3,
        attempts: [
          { caseId: "XEN-364", passed: true, stopReason: "verified", costUsd: 1, iterations: 1, hiddenTestPassed: true, gateResults: [], durationMs: 1000 },
          { caseId: "XEN-364", passed: true, stopReason: "verified", costUsd: 1, iterations: 1, hiddenTestPassed: true, gateResults: [], durationMs: 1000 },
          { caseId: "XEN-364", passed: false, stopReason: "stuck", costUsd: 1, iterations: 2, hiddenTestPassed: false, gateResults: [], durationMs: 1000 },
        ],
      },
    ],
    passAtOneRate: 2 / 3,
    passAtKCount: 0,
    totalCount: 1,
    totalCostUsd: 3,
  };

  const report = formatSuiteReport(result);
  assert.match(report, /FAIL/); // the case-level row: not every attempt passed
  assert.match(report, /2\/3/); // passed-count/k on the case row
  assert.match(report, /pass@1=0\.67/);
  assert.match(report, /#1/); // individual attempts are still listed
  assert.match(report, /#3/);
  assert.match(report, /pass@1 \(mean over 3 runs\/case\): 67%/);
  assert.match(report, /pass\^3 \(every run passed\): 0\/1/);
});
