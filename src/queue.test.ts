import { test } from "node:test";
import assert from "node:assert/strict";
import { splitCrossRepoCriteria } from "./queue.js";

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
