import { test } from "node:test";
import assert from "node:assert/strict";
import { fingerprintFailure } from "./stuckDetector.js";
import type { GateResult } from "../types.js";

function gate(name: string, output: string): GateResult {
  return { name, command: `run ${name}`, passed: false, output };
}

test("identical failures produce the same fingerprint", () => {
  const a = [gate("typecheck", "src/x.ts(10,5): error TS2322: Type mismatch")];
  const b = [gate("typecheck", "src/x.ts(10,5): error TS2322: Type mismatch")];
  assert.equal(fingerprintFailure(a), fingerprintFailure(b));
});

test("a shifted line/column number doesn't change the fingerprint (still the same error)", () => {
  const before = [gate("typecheck", "src/x.ts(10,5): error TS2322: Type mismatch")];
  const after = [gate("typecheck", "src/x.ts(14,9): error TS2322: Type mismatch")];
  assert.equal(fingerprintFailure(before), fingerprintFailure(after));
});

test("a genuinely different error message changes the fingerprint (real progress)", () => {
  const before = [gate("typecheck", "src/x.ts(10,5): error TS2322: Type mismatch")];
  const after = [gate("typecheck", "src/y.ts(3,1): error TS2554: Expected 1 argument")];
  assert.notEqual(fingerprintFailure(before), fingerprintFailure(after));
});

test("a different set of failing gates changes the fingerprint even with similar text", () => {
  const before = [gate("typecheck", "error here")];
  const after = [gate("typecheck", "error here"), gate("lint", "another problem")];
  assert.notEqual(fingerprintFailure(before), fingerprintFailure(after));
});

test("gate order doesn't matter — same set of failures fingerprints the same", () => {
  const a = [gate("typecheck", "err A"), gate("lint", "err B")];
  const b = [gate("lint", "err B"), gate("typecheck", "err A")];
  assert.equal(fingerprintFailure(a), fingerprintFailure(b));
});

test("fixing one gate while another stays broken changes the fingerprint (partial progress counts)", () => {
  const before = [gate("typecheck", "err A"), gate("test", "err B")];
  const after = [gate("test", "err B")]; // typecheck fixed, test still broken the same way
  assert.notEqual(fingerprintFailure(before), fingerprintFailure(after));
});
