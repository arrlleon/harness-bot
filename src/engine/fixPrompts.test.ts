import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAutoFixPrompt, stopGuidance } from "./fixPrompts.js";

const task = { id: "XEN-1", title: "t", description: "d", acceptanceCriteria: ["c"] };

test("stopGuidance tells the agent what stopped the last attempt, per stop reason", () => {
  assert.match(stopGuidance("rebase_conflict (...): x", ["src/a.ts", "docs/b.md"]), /- src\/a\.ts\n- docs\/b\.md/);
  assert.match(stopGuidance("rebase_conflict: x", []), /No\s+conflict marker may remain/);
  assert.match(stopGuidance("review_blocked после 2 раунд(ов) с разработчиком: src/a.ts:1 — SQL-инъекция"), /Blocking findings:\nsrc\/a\.ts:1 — SQL-инъекция/);
  assert.match(stopGuidance("gate_integrity_violation: .only added"), /\.only added[\s\S]*Never skip, delete or loosen/);
  assert.match(stopGuidance("stuck (same failure repeated in: test)"), /do not repeat it/);
  assert.match(stopGuidance("max_iterations"), /do not repeat it/);
  assert.match(stopGuidance("max_budget"), /ran out of budget/);
  assert.match(stopGuidance("context_budget: ~225k"), /interrupted/);
  assert.match(stopGuidance("backend: review_blocked: x"), /independent code review/);
});

test("buildAutoFixPrompt puts the guidance first, then the usual continuation with diff and failing gates", () => {
  const prompt = buildAutoFixPrompt(task, "max_iterations", "+diff line", true, [{ name: "test", command: "jest", passed: false, output: "FAIL x" }]);
  assert.ok(prompt.startsWith("WHAT STOPPED THE PREVIOUS ATTEMPT"));
  assert.match(prompt, /\+diff line/);
  assert.match(prompt, /FAIL x/);
  assert.match(prompt, /Task XEN-1: t/);
});
