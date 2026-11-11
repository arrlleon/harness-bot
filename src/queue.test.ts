import { test } from "node:test";
import assert from "node:assert/strict";
import { splitCrossRepoCriteria, whatsBusy, buildFailureReason } from "./queue.js";
import { setAnalyzing, startJob, finishJob } from "./bot/liveState.js";
import type { CloseLoopResult, ClaudeTurnResult } from "./types.js";

function turn(partial: Partial<ClaudeTurnResult>): ClaudeTurnResult {
  return {
    sessionId: "s1",
    resultText: "",
    isError: false,
    terminalReason: "end_turn",
    totalCostUsd: 0,
    contextTokens: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    ...partial,
  };
}

function closeLoopResult(partial: Partial<CloseLoopResult>): CloseLoopResult {
  return {
    task: { id: "XEN-000", title: "t", description: "d", acceptanceCriteria: [] },
    success: false,
    iterations: [],
    totalCostUsd: 0,
    stopReason: "max_iterations",
    worktreeDir: "/tmp/x",
    ...partial,
  };
}

test("splitCrossRepoCriteria routes each criterion back to the repo it was tagged for", () => {
  const { backend, frontend } = splitCrossRepoCriteria([
    "[backend] возвращает 404 для несуществующего id",
    "[frontend] кнопка disabled во время запроса",
    "[backend] пишет событие в audit log",
  ]);
  assert.deepEqual(backend, ["возвращает 404 для несуществующего id", "пишет событие в audit log"]);
  assert.deepEqual(frontend, ["кнопка disabled во время запроса"]);
});

test("splitCrossRepoCriteria returns empty lists for an empty input", () => {
  assert.deepEqual(splitCrossRepoCriteria([]), { backend: [], frontend: [] });
});

test("splitCrossRepoCriteria drops an untagged criterion rather than guessing which repo it belongs to", () => {
  const { backend, frontend } = splitCrossRepoCriteria([
    "[backend] валидный критерий",
    "критерий без префикса — не должен попасть никуда",
  ]);
  assert.deepEqual(backend, ["валидный критерий"]);
  assert.deepEqual(frontend, []);
});

// Reproduced live (2026-11-10): picking a ticket whose analysis was already in flight
// got a generic "не удалось начать" instead of naming XEN-541 — these pin whatsBusy's
// exact precedence (currentJob first, then a concrete `analyzing` key, with the
// "searching" placeholder treated as nothing-to-name) so that message stays accurate.
test("whatsBusy names the in-progress analysis target", () => {
  setAnalyzing("XEN-541");
  assert.equal(whatsBusy(), "XEN-541");
  setAnalyzing(null);
});

test("whatsBusy ignores proposeNext's own 'searching' placeholder", () => {
  setAnalyzing("searching");
  assert.equal(whatsBusy(), undefined);
  setAnalyzing(null);
});

test("whatsBusy prefers a running job over a concurrent analysis", () => {
  startJob("XEN-540", "title", "desc", "frontend", 10);
  setAnalyzing("XEN-541");
  assert.equal(whatsBusy(), "XEN-540");
  finishJob();
  setAnalyzing(null);
});

test("whatsBusy returns undefined when nothing is actually busy", () => {
  assert.equal(whatsBusy(), undefined);
});

// Reproduced live (2026-11-10, XEN-541): "agent_error" alone, with no further detail,
// left a human with nothing to go on beyond the bare word — every OTHER stopReason
// here already names its own specifics; this pins that agent_error does too now, and
// that the others still do.
test("buildFailureReason names the repeated gate(s) for 'stuck'", () => {
  const result = closeLoopResult({ stopReason: "stuck", stuckGates: ["test", "build"] });
  assert.equal(buildFailureReason(result), "stuck (same failure repeated in: test, build)");
});

test("buildFailureReason names only the blocking findings for 'review_blocked'", () => {
  const result = closeLoopResult({
    stopReason: "review_blocked",
    reviewRounds: 2,
    reviewFindings: [
      { description: "race condition in X", blocking: true },
      { description: "minor style nit", blocking: false },
    ] as CloseLoopResult["reviewFindings"],
  });
  assert.equal(buildFailureReason(result), "review_blocked после 2 раунд(ов) с разработчиком: race condition in X");
});

test("buildFailureReason lists every gate-integrity violation", () => {
  const result = closeLoopResult({
    stopReason: "gate_integrity_violation",
    gateIntegrityViolations: ["удалён тестовый файл: a.test.ts", "правка CI-конфига: .gitlab-ci.yml"],
  });
  assert.equal(
    buildFailureReason(result),
    "gate_integrity_violation: удалён тестовый файл: a.test.ts; правка CI-конфига: .gitlab-ci.yml",
  );
});

test("buildFailureReason reports the measured token count for 'context_budget'", () => {
  const result = closeLoopResult({ stopReason: "context_budget", contextTokens: 187269 });
  assert.match(buildFailureReason(result), /~187k токенов/);
  assert.doesNotMatch(buildFailureReason(result), /не прошли гейты/);
});

// Reproduced live (XEN-540): the stopped turn's gates had caught a real tsc error, but
// only the token count reached the human — the reason now at least names which gates.
test("buildFailureReason names the gates that were failing at a 'context_budget' stop", () => {
  const result = closeLoopResult({
    stopReason: "context_budget",
    contextTokens: 187269,
    resumeState: {
      sessionId: "s1",
      worktreeDir: "/tmp/x",
      iteration: 0,
      totalCostUsd: 1,
      gates: [],
      baselines: [],
      freshSession: true,
      failedGates: [
        { name: "typecheck", command: "tsc", passed: false, output: "error TS1005" },
        { name: "test", command: "jest", passed: false, output: "1 failed" },
      ],
    },
  });
  assert.match(buildFailureReason(result), /не прошли гейты: typecheck, test/);
});

test("buildFailureReason includes the raw conflict output for 'rebase_conflict'", () => {
  const result = closeLoopResult({ stopReason: "rebase_conflict", rebaseConflictOutput: "CONFLICT in src/a.ts" });
  assert.match(buildFailureReason(result), /CONFLICT in src\/a\.ts/);
});

test("buildFailureReason surfaces the failing turn's own resultText for 'agent_error'", () => {
  const result = closeLoopResult({
    stopReason: "agent_error",
    iterations: [
      { turn: turn({ resultText: "ok so far" }), verify: { passed: true, output: "", gates: [] } },
      { turn: turn({ resultText: "API error: overloaded_error", isError: true }), verify: { passed: false, output: "", gates: [] } },
    ],
  });
  assert.equal(buildFailureReason(result), "agent_error: API error: overloaded_error");
});

test("buildFailureReason falls back to the bare word when agent_error has nothing to add", () => {
  const withEmptyText = closeLoopResult({
    stopReason: "agent_error",
    iterations: [{ turn: turn({ resultText: "   ", isError: true }), verify: { passed: false, output: "", gates: [] } }],
  });
  assert.equal(buildFailureReason(withEmptyText), "agent_error");

  const withNoIterations = closeLoopResult({ stopReason: "agent_error", iterations: [] });
  assert.equal(buildFailureReason(withNoIterations), "agent_error");
});

test("buildFailureReason falls back to the bare stopReason for anything with nothing extra to add", () => {
  assert.equal(buildFailureReason(closeLoopResult({ stopReason: "max_iterations" })), "max_iterations");
  assert.equal(buildFailureReason(closeLoopResult({ stopReason: "max_budget" })), "max_budget");
});
