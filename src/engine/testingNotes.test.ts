import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestingNotesPrompt } from "./testingNotes.js";
import type { TaskSpec } from "../types.js";

const task: TaskSpec = {
  id: "XEN-55",
  title: "Пагинация не работает для архивных записей",
  description: "Фильтр по статусу не учитывает архивные записи.",
  acceptanceCriteria: ["Архивные записи не попадают в выдачу по умолчанию"],
};

test("buildTestingNotesPrompt includes the task, criteria, and diff", () => {
  const prompt = buildTestingNotesPrompt(task, "diff --git a/x.ts b/x.ts\n+added line");
  assert.match(prompt, /XEN-55/);
  assert.match(prompt, /Архивные записи не попадают/);
  assert.match(prompt, /added line/);
  assert.match(prompt, /ПРЕДУСЛОВИЯ:/);
  assert.match(prompt, /ШАГИ:/);
  assert.match(prompt, /ОЖИДАЕМЫЙ РЕЗУЛЬТАТ:/);
});

test("buildTestingNotesPrompt tells the model to avoid code-level references", () => {
  const prompt = buildTestingNotesPrompt(task, "diff");
  assert.match(prompt, /не будет.*читать код/s);
});

test("buildTestingNotesPrompt handles a task with no frozen acceptance criteria", () => {
  const bare: TaskSpec = { ...task, acceptanceCriteria: [] };
  const prompt = buildTestingNotesPrompt(bare, "diff");
  assert.match(prompt, /не зафиксированы для этой задачи/);
});

test("buildTestingNotesPrompt caps the embedded diff", () => {
  const longDiff = "x".repeat(20_000);
  const prompt = buildTestingNotesPrompt(task, longDiff);
  assert.ok(prompt.length < 12_000, `expected the diff to be capped, got a ${prompt.length}-char prompt`);
});
