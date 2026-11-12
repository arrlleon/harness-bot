import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewResumeNowUnsafe, withFixResumeState } from "./loop.js";
import type { CloseLoopResult } from "../types.js";

test("reviewResumeNowUnsafe is false when there's nothing being resumed", () => {
  assert.equal(reviewResumeNowUnsafe(undefined, { maxRounds: 3 }), false);
  assert.equal(reviewResumeNowUnsafe(undefined, undefined), false);
});

test("reviewResumeNowUnsafe is false for the ordinary case: review still enabled, round still in range", () => {
  assert.equal(reviewResumeNowUnsafe({ round: 1 }, { maxRounds: 3 }), false);
  assert.equal(reviewResumeNowUnsafe({ round: 2 }, { maxRounds: 3 }), false);
});

test("reviewResumeNowUnsafe is true when review was disabled since the brief was raised", () => {
  // REVIEW_ENABLED flipped to false (+ bot restart) while a review-fix brief sat
  // pending — silently continuing would skip the pending human answer entirely.
  assert.equal(reviewResumeNowUnsafe({ round: 1 }, undefined), true);
});

test("reviewResumeNowUnsafe is true when MAX_REVIEW_ROUNDS was lowered below the resuming round", () => {
  // The brief was raised fixing round 3's findings; maxRounds dropped to 2 since —
  // a plain `for (round = 3; round <= 2; ...)` would never run at all.
  assert.equal(reviewResumeNowUnsafe({ round: 3 }, { maxRounds: 2 }), true);
});

test("reviewResumeNowUnsafe is false at the boundary: resuming round equals the current maxRounds", () => {
  assert.equal(reviewResumeNowUnsafe({ round: 2 }, { maxRounds: 2 }), false);
});

// "🛠 Решить самому" needs something to resume from on every stop, not just the two
// that used to carry it (context_budget, agent_error).
function failed(stopReason: CloseLoopResult["stopReason"], extra: Partial<CloseLoopResult> = {}): CloseLoopResult {
  return {
    task: { id: "X-1", title: "t", description: "", acceptanceCriteria: [] },
    success: false,
    iterations: [],
    totalCostUsd: 12.5,
    stopReason,
    worktreeDir: "/tmp/wt",
    ...extra,
  } as CloseLoopResult;
}
const setup = { gates: [{ name: "test", command: "jest" }], baselines: [], acceptanceTestPath: "src/__acceptance__/x.spec.ts" };

test("withFixResumeState gives every failed stop a fresh-session resume state", () => {
  for (const reason of ["max_iterations", "stuck", "review_blocked", "max_budget", "gate_integrity_violation", "rebase_conflict"] as const) {
    const rs = withFixResumeState(failed(reason), setup).resumeState;
    assert.ok(rs, reason);
    assert.equal(rs!.freshSession, true);
    assert.equal(rs!.iteration, 0);
    assert.equal(rs!.totalCostUsd, 12.5);
    assert.equal(rs!.worktreeDir, "/tmp/wt");
    assert.equal(rs!.acceptanceTestPath, "src/__acceptance__/x.spec.ts");
  }
});

test("withFixResumeState carries the last attempt's failing gates", () => {
  const iterations = [
    { turn: {} as never, verify: { passed: false, output: "", gates: [{ name: "test", command: "jest", passed: false, output: "boom" }, { name: "build", command: "b", passed: true, output: "" }] } },
  ];
  const rs = withFixResumeState(failed("max_iterations", { iterations }), setup).resumeState!;
  assert.deepEqual(rs.failedGates?.map((g) => g.name), ["test"]);
});

test("withFixResumeState leaves success, briefs, existing resume states and unknown setups alone", () => {
  const ok = { ...failed("verified"), success: true };
  assert.equal(withFixResumeState(ok, setup), ok);
  const brief = failed("brief_pending");
  assert.equal(withFixResumeState(brief, setup).resumeState, undefined);
  const own = failed("agent_error", { resumeState: { sessionId: "s", worktreeDir: "/tmp/wt", iteration: 2, totalCostUsd: 1, gates: [], baselines: [] } });
  assert.equal(withFixResumeState(own, setup).resumeState!.sessionId, "s");
  assert.equal(withFixResumeState(failed("stuck"), {}).resumeState, undefined);
});
