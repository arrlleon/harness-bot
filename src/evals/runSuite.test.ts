import { test } from "node:test";
import assert from "node:assert/strict";
import { average, aggregateAttempts } from "./runSuite.js";
import type { EvalCaseResult } from "./types.js";

function attempt(partial: Partial<EvalCaseResult>): EvalCaseResult {
  return {
    caseId: "XEN-000",
    passed: false,
    stopReason: "verified",
    costUsd: 0,
    iterations: 1,
    hiddenTestPassed: false,
    gateResults: [],
    durationMs: 0,
    ...partial,
  };
}

test("average of a single value is itself", () => {
  assert.equal(average([5]), 5);
});

test("average computes the mean across several values", () => {
  assert.equal(average([1, 2, 3]), 2);
});

test("aggregateAttempts: all attempts passing gives passAtOneRate 1 and passAtK true", () => {
  const agg = aggregateAttempts("XEN-364", [attempt({ passed: true, costUsd: 1 }), attempt({ passed: true, costUsd: 2 })]);
  assert.equal(agg.passAtOneRate, 1);
  assert.equal(agg.passAtK, true);
  assert.equal(agg.totalCostUsd, 3);
});

test("aggregateAttempts: a mix of pass/fail gives the right pass@1 rate and passAtK false", () => {
  const agg = aggregateAttempts("XEN-364", [attempt({ passed: true }), attempt({ passed: true }), attempt({ passed: false })]);
  assert.equal(agg.passAtOneRate, 2 / 3);
  assert.equal(agg.passAtK, false); // not every attempt passed
});

test("aggregateAttempts: all attempts failing gives passAtOneRate 0 and passAtK false", () => {
  const agg = aggregateAttempts("XEN-364", [attempt({ passed: false }), attempt({ passed: false })]);
  assert.equal(agg.passAtOneRate, 0);
  assert.equal(agg.passAtK, false);
});

test("aggregateAttempts: a single attempt (k=1) reduces to that attempt's own pass/fail", () => {
  const passing = aggregateAttempts("XEN-364", [attempt({ passed: true })]);
  assert.equal(passing.passAtOneRate, 1);
  assert.equal(passing.passAtK, true);

  const failing = aggregateAttempts("XEN-364", [attempt({ passed: false })]);
  assert.equal(failing.passAtOneRate, 0);
  assert.equal(failing.passAtK, false);
});

test("aggregateAttempts sums cost across every attempt, not just the last one", () => {
  const agg = aggregateAttempts("XEN-364", [attempt({ costUsd: 0.5 }), attempt({ costUsd: 0.25 }), attempt({ costUsd: 1 })]);
  assert.equal(agg.totalCostUsd, 1.75);
});

test("aggregateAttempts keeps every attempt's own result, not just the aggregate numbers", () => {
  const a = attempt({ passed: true, stopReason: "verified" });
  const b = attempt({ passed: false, stopReason: "stuck" });
  const agg = aggregateAttempts("XEN-364", [a, b]);
  assert.deepEqual(agg.attempts, [a, b]);
});
