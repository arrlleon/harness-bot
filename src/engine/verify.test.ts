import { test } from "node:test";
import assert from "node:assert/strict";
import { establishBaselines, runGates, compareGate, classifyCrash, parseFailureCount, gateEnv, stripAnsi, GateInfraError } from "./verify.js";
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

test("strict gate (acceptance test) fails at baseline and must still fail if unchanged — no 'already broken' tolerance", async () => {
  const gates: GateSpec[] = [{ name: "acceptance", command: "echo 'Tests: 1 failed' && exit 1", strict: true }];
  const baselines = await establishBaselines(".", gates);

  // Same failing command run again, completely unchanged — a baseline-relative gate
  // would call this "no worse than before" and pass; a strict gate must not.
  const stillFailing = await runGates(".", gates, baselines);
  assert.equal(stillFailing.passed, false);
});

test("strict gate passes once it actually exits 0, regardless of a failing baseline", async () => {
  const baselineGates: GateSpec[] = [{ name: "acceptance", command: "exit 1", strict: true }];
  const baselines = await establishBaselines(".", baselineGates);

  const fixedGates: GateSpec[] = [{ name: "acceptance", command: "exit 0", strict: true }];
  const result = await runGates(".", fixedGates, baselines);
  assert.equal(result.passed, true);
});

// A strict gate's baseline is never consulted (both tests above pass regardless of
// what the baseline command even was) — establishBaselines shouldn't bother running
// it at all. Matters doubly for a diff-scoped test command (scripts/scoped-test-
// backend.sh): run at baseline time, before the agent's first edit, it would find
// nothing changed and do nothing useful anyway.
test("establishBaselines skips running a strict gate's command at all", async () => {
  const gates: GateSpec[] = [
    { name: "test", command: "echo 'Tests: 2 failed' && exit 1" },
    { name: "acceptance", command: "echo should never run && exit 1", strict: true },
  ];
  const baselines = await establishBaselines(".", gates);
  assert.equal(baselines.length, 1);
  assert.equal(baselines[0].name, "test");
});

// Reproduced live (XEN-540): tsc died with "JavaScript heap out of memory" at baseline,
// which recorded { exitedZero: false, failureCount: null } — and compareGate then
// passed the gate for the rest of the task whatever the code did.
test("a gate that runs out of memory throws GateInfraError instead of recording a baseline", async () => {
  const gates: GateSpec[] = [{ name: "typecheck", command: "echo 'FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory' && exit 134" }];
  await assert.rejects(() => establishBaselines(".", gates), GateInfraError);
  await assert.rejects(() => runGates(".", gates, []), GateInfraError);
});

test("classifyCrash recognises timeout, buffer overflow and OOM, and nothing else", () => {
  assert.match(classifyCrash({ killed: true, signal: "SIGKILL" }, "", 60_000) ?? "", /не завершился/);
  assert.match(classifyCrash({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }, "", 60_000) ?? "", /буфера/);
  assert.match(classifyCrash({ code: 134 }, "JavaScript heap out of memory", 60_000) ?? "", /памяти/);
  assert.equal(classifyCrash({ code: 1 }, "src/a.ts(1,1): error TS1005: ',' expected.", 60_000), undefined);
});

test("compareGate fails a gate whose baseline was countable but whose current output isn't", () => {
  const gate: GateSpec = { name: "typecheck", command: "tsc" };
  const baseline = { name: "typecheck", command: "tsc", exitedZero: false, failureCount: 53 };
  assert.equal(compareGate(gate, baseline, false, "something unrecognisable"), false);
  assert.equal(compareGate(gate, baseline, false, "a.ts(1,1): error TS1: x\n".repeat(53)), true);
  assert.equal(compareGate(gate, baseline, false, "a.ts(1,1): error TS1: x\n".repeat(54)), false);
});

test("the build gate is countable: nest build's summary, colour codes and all", () => {
  const raw = "\u001b[91merror\u001b[0m\u001b[90m TS2307: \u001b[0mCannot find module\n\nFound 8 error(s).\n";
  assert.equal(parseFailureCount("build", stripAnsi(raw)), 8);
  // Unstripped, the colour codes sit between "error" and "TS2307" and hide the match.
  assert.equal(parseFailureCount("typecheck", raw), null);
  assert.equal(parseFailureCount("typecheck", stripAnsi(raw)), 1);
});

test("gateEnv strips harness secrets and raises the Node heap without clobbering existing options", () => {
  const env = gateEnv({ PATH: "/usr/bin", JIRA_PAT: "secret", GITLAB_TOKEN: "secret", NODE_OPTIONS: "--enable-source-maps" });
  assert.equal(env.JIRA_PAT, undefined);
  assert.equal(env.GITLAB_TOKEN, undefined);
  assert.match(env.NODE_OPTIONS ?? "", /--enable-source-maps --max-old-space-size=\d+/);
  assert.equal(gateEnv({ NODE_OPTIONS: "--max-old-space-size=8192" }).NODE_OPTIONS, "--max-old-space-size=8192");
});
