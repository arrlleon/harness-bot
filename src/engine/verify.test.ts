import { test } from "node:test";
import assert from "node:assert/strict";
import { establishBaselines, runGates } from "./verify.js";
import type { GateSpec } from "../types.js";

// All commands here are synthetic (echo/exit), not real project scripts — these tests
// exercise the baseline-comparison logic itself, not any particular repo's tooling.

test("test gate: passes when the failure count stays the same or improves", async () => {
  const before: GateSpec[] = [{ name: "test", command: "echo 'Tests: 2 failed, 8 passed' && exit 1" }];
  const baselines = await establishBaselines(".", before);
  assert.equal(baselines[0].failureCount, 2);
  assert.equal(baselines[0].exitedZero, false);

  const after: GateSpec[] = [{ name: "test", command: "echo 'Tests: 1 failed, 9 passed' && exit 1" }];
  const result = await runGates(".", after, baselines);
  assert.equal(result.passed, true);
  assert.equal(result.gates[0].passed, true);
});

test("test gate: fails when the failure count regresses", async () => {
  const before: GateSpec[] = [{ name: "test", command: "echo 'Tests: 2 failed, 8 passed' && exit 1" }];
  const baselines = await establishBaselines(".", before);

  const after: GateSpec[] = [{ name: "test", command: "echo 'Tests: 5 failed, 5 passed' && exit 1" }];
  const result = await runGates(".", after, baselines);
  assert.equal(result.passed, false);
  assert.equal(result.gates[0].passed, false);
});

test("test gate: an exit-0 run always passes regardless of baseline", async () => {
  const before: GateSpec[] = [{ name: "test", command: "echo 'Tests: 4 failed, 6 passed' && exit 1" }];
  const baselines = await establishBaselines(".", before);

  const after: GateSpec[] = [{ name: "test", command: "exit 0" }];
  const result = await runGates(".", after, baselines);
  assert.equal(result.passed, true);
});

test("typecheck gate: counts 'error TSxxxx:' occurrences, not just exit code", async () => {
  const before: GateSpec[] = [
    { name: "typecheck", command: "echo 'a.ts: error TS2322: x' && echo 'b.ts: error TS2345: y' && exit 1" },
  ];
  const baselines = await establishBaselines(".", before);
  assert.equal(baselines[0].failureCount, 2);

  // One pre-existing error fixed, none introduced — should pass.
  const improved: GateSpec[] = [{ name: "typecheck", command: "echo 'a.ts: error TS2322: x' && exit 1" }];
  assert.equal((await runGates(".", improved, baselines)).passed, true);

  // A brand new error on top of the two pre-existing ones — should fail.
  const regressed: GateSpec[] = [
    { name: "typecheck", command: "echo 'a.ts: error TS2322: x' && echo 'b.ts: error TS2345: y' && echo 'c.ts: error TS9999: z' && exit 1" },
  ];
  assert.equal((await runGates(".", regressed, baselines)).passed, false);
});

test("lint gate: parses the 'N problems' eslint summary", async () => {
  const before: GateSpec[] = [{ name: "lint", command: "echo '✖ 397 problems (18 errors, 379 warnings)' && exit 1" }];
  const baselines = await establishBaselines(".", before);
  assert.equal(baselines[0].failureCount, 397);

  const same: GateSpec[] = [{ name: "lint", command: "echo '✖ 397 problems (18 errors, 379 warnings)' && exit 1" }];
  assert.equal((await runGates(".", same, baselines)).passed, true);

  const worse: GateSpec[] = [{ name: "lint", command: "echo '✖ 400 problems (20 errors, 380 warnings)' && exit 1" }];
  assert.equal((await runGates(".", worse, baselines)).passed, false);
});

test("gate with no parseable count (e.g. build) falls back to exit-code comparison", async () => {
  // Baseline build is already broken for unrelated reasons — shouldn't block the fix.
  const brokenBaseline: GateSpec[] = [{ name: "build", command: "echo 'unrelated pre-existing break' && exit 1" }];
  const baselines = await establishBaselines(".", brokenBaseline);
  assert.equal(baselines[0].failureCount, null);
  assert.equal(baselines[0].exitedZero, false);

  const stillBroken: GateSpec[] = [{ name: "build", command: "echo 'same unrelated break' && exit 1" }];
  assert.equal((await runGates(".", stillBroken, baselines)).passed, true);
});

test("gate with no parseable count regresses when baseline was clean", async () => {
  const cleanBaseline: GateSpec[] = [{ name: "build", command: "exit 0" }];
  const baselines = await establishBaselines(".", cleanBaseline);
  assert.equal(baselines[0].exitedZero, true);

  const nowBroken: GateSpec[] = [{ name: "build", command: "echo 'newly broken' && exit 1" }];
  assert.equal((await runGates(".", nowBroken, baselines)).passed, false);
});

test("runGates runs every gate (doesn't stop at the first failure) and labels each in the combined output", async () => {
  // Baseline: everything was clean before the agent's edit — so any gate failing
  // below is a genuine new regression, not a pre-existing break.
  const cleanGates: GateSpec[] = [
    { name: "typecheck", command: "exit 0" },
    { name: "lint", command: "exit 0" },
    { name: "build", command: "exit 0" },
  ];
  const baselines = await establishBaselines(".", cleanGates);

  const gatesAfterEdit: GateSpec[] = [
    { name: "typecheck", command: "exit 0" },
    { name: "lint", command: "echo 'lint broke' && exit 1" },
    { name: "build", command: "echo 'build broke' && exit 1" },
  ];
  const result = await runGates(".", gatesAfterEdit, baselines);

  assert.equal(result.passed, false);
  assert.equal(result.gates.length, 3);
  assert.equal(result.gates[0].passed, true); // typecheck
  assert.equal(result.gates[1].passed, false); // lint
  assert.equal(result.gates[2].passed, false); // build
  assert.match(result.output, /\[lint\]/);
  assert.match(result.output, /lint broke/);
  assert.match(result.output, /\[build\]/);
  assert.match(result.output, /build broke/);
});
