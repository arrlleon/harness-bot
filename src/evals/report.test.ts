import { test } from "node:test";
import assert from "node:assert/strict";
import { formatSuiteReport } from "./report.js";
import type { EvalSuiteResult } from "./types.js";

test("formatSuiteReport includes every case, its status, cost, and gate breakdown", () => {
  const result: EvalSuiteResult = {
    runAt: "2026-11-03T12:00:00.000Z",
    model: "claude-opus-5",
    cases: [
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
    passCount: 1,
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
    cases: [
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
    passCount: 0,
    totalCount: 1,
    totalCostUsd: 0,
  };
  const report = formatSuiteReport(result);
  assert.match(report, /\(none ran\)/);
});
