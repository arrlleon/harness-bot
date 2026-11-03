import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEvalGates } from "./gates.js";
import type { GateSpec } from "../types.js";

test("buildEvalGates drops the full-suite 'test' gate but keeps typecheck/build", () => {
  const repoGates: GateSpec[] = [
    { name: "typecheck", command: "yarn tsc --noEmit" },
    { name: "test", command: "yarn test" },
    { name: "build", command: "yarn build" },
  ];
  const gates = buildEvalGates(repoGates, "npx jest", ["src/x.spec.ts"]);
  assert.deepEqual(
    gates.map((g) => g.name),
    ["typecheck", "build", "hidden_test"],
  );
});

test("buildEvalGates appends the hidden test as a strict gate with the given runner and paths", () => {
  const gates = buildEvalGates([], "npx vitest run", ["src/a.test.ts", "src/b.test.ts"]);
  assert.deepEqual(gates, [
    { name: "hidden_test", command: "npx vitest run src/a.test.ts src/b.test.ts", strict: true },
  ]);
});

test("buildEvalGates works when the repo has no configured gates at all beyond 'test'", () => {
  const gates = buildEvalGates([{ name: "test", command: "yarn test" }], "npx jest", ["src/x.spec.ts"]);
  assert.deepEqual(
    gates.map((g) => g.name),
    ["hidden_test"],
  );
});
