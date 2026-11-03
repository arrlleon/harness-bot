import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMemoryContextBlock, buildMemoryUpdatePrompt } from "./memory.js";
import type { TaskSpec } from "../types.js";

const task: TaskSpec = {
  id: "XEN-55",
  title: "Пагинация не работает для архивных записей",
  description: "Фильтр по статусу не учитывает архивные записи.",
  acceptanceCriteria: [],
};

test("buildMemoryContextBlock omits a section entirely when that memory file doesn't exist", () => {
  const onlyHarness = buildMemoryContextBlock({ team: null, harness: "# notes\n- a fact" });
  assert.doesNotMatch(onlyHarness, /Memory команды проекта/);
  assert.match(onlyHarness, /Накопленные заметки jira-harness/);
  assert.match(onlyHarness, /- a fact/);

  const onlyTeam = buildMemoryContextBlock({ team: "# team notes", harness: null });
  assert.match(onlyTeam, /Memory команды проекта/);
  assert.doesNotMatch(onlyTeam, /Накопленные заметки jira-harness/);
});

test("buildMemoryContextBlock returns an empty string when neither file exists", () => {
  assert.equal(buildMemoryContextBlock({ team: null, harness: null }), "");
});

test("buildMemoryContextBlock includes both sections when both files exist", () => {
  const block = buildMemoryContextBlock({ team: "team stuff", harness: "harness stuff" });
  assert.match(block, /team stuff/);
  assert.match(block, /harness stuff/);
});

test("buildMemoryUpdatePrompt includes the task, the diff, and the existing memory content", () => {
  const prompt = buildMemoryUpdatePrompt(task, "# old notes\n- old fact", "diff --git a/x.ts b/x.ts\n+added line");
  assert.match(prompt, /XEN-55/);
  assert.match(prompt, /old fact/);
  assert.match(prompt, /added line/);
  assert.match(prompt, /<memory>NONE<\/memory>/);
});

test("buildMemoryUpdatePrompt handles a missing memory file gracefully", () => {
  const prompt = buildMemoryUpdatePrompt(task, null, "diff --git a/x.ts b/x.ts\n+added line");
  assert.match(prompt, /\(файла ещё нет\)/);
});

test("buildMemoryUpdatePrompt caps the diff it embeds", () => {
  const longDiff = "x".repeat(10_000);
  const prompt = buildMemoryUpdatePrompt(task, null, longDiff);
  assert.ok(prompt.length < 9_000, `expected the diff to be capped, got a ${prompt.length}-char prompt`);
});
