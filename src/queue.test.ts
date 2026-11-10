import { test } from "node:test";
import assert from "node:assert/strict";
import { splitCrossRepoCriteria, whatsBusy } from "./queue.js";
import { setAnalyzing, startJob, finishJob } from "./bot/liveState.js";

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
