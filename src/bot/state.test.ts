import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateCost, computeMetrics, type BotState, type TaskRecord } from "./state.js";

function record(partial: Partial<TaskRecord> & { issueKey: string }): TaskRecord {
  return {
    outcome: "closed",
    detail: "",
    costUsd: 0,
    timestamp: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

function stateWith(history: TaskRecord[]): BotState {
  return { running: false, history };
}

test("estimateCost returns null when there's no usable history yet", () => {
  assert.equal(estimateCost(stateWith([])), null);
});

test("estimateCost excludes 'skipped' (cancelled, no real work) and zero-cost records", () => {
  const state = stateWith([
    record({ issueKey: "A", outcome: "skipped", costUsd: 5 }), // cancelled — excluded regardless of cost
    record({ issueKey: "B", outcome: "closed", costUsd: 0 }), // zero cost — excluded, not a real sample
  ]);
  assert.equal(estimateCost(state), null);
});

test("estimateCost computes average/median cost from 'closed' and 'needs_human' records", () => {
  const state = stateWith([
    record({ issueKey: "A", outcome: "closed", costUsd: 1 }),
    record({ issueKey: "B", outcome: "needs_human", costUsd: 2 }),
    record({ issueKey: "C", outcome: "closed", costUsd: 3 }),
  ]);
  const estimate = estimateCost(state);
  assert.equal(estimate?.sampleSize, 3);
  assert.equal(estimate?.avgCostUsd, 2);
  assert.equal(estimate?.medianCostUsd, 2);
});

test("estimateCost tolerates records with no durationMs (pre-existing history) without crashing", () => {
  const state = stateWith([
    record({ issueKey: "A", outcome: "closed", costUsd: 1 }), // no durationMs at all
    record({ issueKey: "B", outcome: "closed", costUsd: 2, durationMs: 60_000 }),
  ]);
  const estimate = estimateCost(state);
  assert.equal(estimate?.sampleSize, 2); // both count toward cost
  assert.equal(estimate?.avgDurationMs, 60_000); // only the one with real duration counts toward duration
  assert.equal(estimate?.medianDurationMs, 60_000);
});

test("estimateCost returns null durations (not zero) when nothing in the pool has a recorded duration", () => {
  const state = stateWith([record({ issueKey: "A", outcome: "closed", costUsd: 1 })]);
  const estimate = estimateCost(state);
  assert.equal(estimate?.avgDurationMs, null);
  assert.equal(estimate?.medianDurationMs, null);
});

test("estimateCost prefers same-repo history once there are at least 3 samples for it", () => {
  const state = stateWith([
    record({ issueKey: "A", outcome: "closed", costUsd: 10, repo: "backend" }),
    record({ issueKey: "B", outcome: "closed", costUsd: 10, repo: "backend" }),
    record({ issueKey: "C", outcome: "closed", costUsd: 10, repo: "backend" }),
    record({ issueKey: "D", outcome: "closed", costUsd: 1, repo: "frontend" }),
  ]);
  const estimate = estimateCost(state, "backend");
  assert.equal(estimate?.sampleSize, 3);
  assert.equal(estimate?.avgCostUsd, 10);
});

test("estimateCost falls back to overall history when the repo has fewer than 3 samples", () => {
  const state = stateWith([
    record({ issueKey: "A", outcome: "closed", costUsd: 10, repo: "backend" }),
    record({ issueKey: "B", outcome: "closed", costUsd: 2, repo: "frontend" }),
    record({ issueKey: "C", outcome: "closed", costUsd: 2, repo: "frontend" }),
  ]);
  // Only 1 "backend" sample — not enough to trust on its own, falls back to all 3.
  const estimate = estimateCost(state, "backend");
  assert.equal(estimate?.sampleSize, 3);
});

test("estimateCost with no repo argument uses the overall history directly", () => {
  const state = stateWith([
    record({ issueKey: "A", outcome: "closed", costUsd: 4, repo: "backend" }),
    record({ issueKey: "B", outcome: "closed", costUsd: 6, repo: "frontend" }),
  ]);
  const estimate = estimateCost(state);
  assert.equal(estimate?.sampleSize, 2);
  assert.equal(estimate?.avgCostUsd, 5);
});

test("computeMetrics returns null when there's no closed/needs_human history yet", () => {
  assert.equal(computeMetrics(stateWith([])), null);
  assert.equal(computeMetrics(stateWith([record({ issueKey: "A", outcome: "skipped" })])), null);
});

test("computeMetrics counts closed vs needs_human and derives the escalation rate", () => {
  const state = stateWith([
    record({ issueKey: "A", outcome: "closed" }),
    record({ issueKey: "B", outcome: "closed" }),
    record({ issueKey: "C", outcome: "needs_human" }),
    record({ issueKey: "D", outcome: "skipped" }), // excluded from every count below
  ]);
  const metrics = computeMetrics(state);
  assert.equal(metrics?.totalTasks, 3);
  assert.equal(metrics?.closedCount, 2);
  assert.equal(metrics?.needsHumanCount, 1);
  assert.equal(metrics?.escalationRate, 1 / 3);
});

test("computeMetrics computes average/median cost and duration across closed and needs_human", () => {
  const state = stateWith([
    record({ issueKey: "A", outcome: "closed", costUsd: 1, durationMs: 60_000 }),
    record({ issueKey: "B", outcome: "needs_human", costUsd: 3, durationMs: 120_000 }),
  ]);
  const metrics = computeMetrics(state);
  assert.equal(metrics?.avgCostUsd, 2);
  assert.equal(metrics?.medianCostUsd, 2);
  assert.equal(metrics?.avgDurationMs, 90_000);
  assert.equal(metrics?.medianDurationMs, 90_000);
});

test("computeMetrics returns null durations when nothing in history has a recorded duration", () => {
  const state = stateWith([record({ issueKey: "A", outcome: "closed", costUsd: 1 })]);
  const metrics = computeMetrics(state);
  assert.equal(metrics?.avgDurationMs, null);
  assert.equal(metrics?.medianDurationMs, null);
});

test("computeMetrics averages reviewRounds over closed tasks only, excluding needs_human", () => {
  const state = stateWith([
    record({ issueKey: "A", outcome: "closed", reviewRounds: 1 }),
    record({ issueKey: "B", outcome: "closed", reviewRounds: 3 }),
    // A needs_human escalation's own round count shouldn't dilute "rounds on a closed task".
    record({ issueKey: "C", outcome: "needs_human", reviewRounds: 3 }),
  ]);
  const metrics = computeMetrics(state);
  assert.equal(metrics?.avgReviewRounds, 2);
});

test("computeMetrics returns null avgReviewRounds when review never ran for any closed task", () => {
  const state = stateWith([record({ issueKey: "A", outcome: "closed" })]);
  const metrics = computeMetrics(state);
  assert.equal(metrics?.avgReviewRounds, null);
});

test("computeMetrics breaks totals down per repo, grouping anything unlabeled under 'unknown'", () => {
  const state = stateWith([
    record({ issueKey: "A", outcome: "closed", repo: "backend" }),
    record({ issueKey: "B", outcome: "needs_human", repo: "backend" }),
    record({ issueKey: "C", outcome: "closed", repo: "frontend" }),
    record({ issueKey: "D", outcome: "closed" }), // no repo at all — pre-existing/ad-hoc record
  ]);
  const metrics = computeMetrics(state);
  assert.deepEqual(metrics?.byRepo.backend, { total: 2, closed: 1, needsHuman: 1 });
  assert.deepEqual(metrics?.byRepo.frontend, { total: 1, closed: 1, needsHuman: 0 });
  assert.deepEqual(metrics?.byRepo.unknown, { total: 1, closed: 1, needsHuman: 0 });
});
