import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateCost, type BotState, type TaskRecord } from "./state.js";

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
