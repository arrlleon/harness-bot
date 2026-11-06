import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCloseReportPrompt } from "./closeReport.js";
import type { TaskSpec } from "../types.js";

const task: TaskSpec = {
  id: "XEN-55",
  title: "Пагинация не работает для архивных записей",
  description: "Фильтр по статусу не учитывает архивные записи.",
  acceptanceCriteria: ["Архивные записи не попадают в выдачу по умолчанию"],
};

test("buildCloseReportPrompt includes the task and the diff", () => {
  const prompt = buildCloseReportPrompt(task, "diff --git a/x.ts b/x.ts\n+added line");
  assert.match(prompt, /XEN-55/);
  assert.match(prompt, /Пагинация не работает/);
  assert.match(prompt, /added line/);
});

test("buildCloseReportPrompt tells the model to write for a non-technical audience", () => {
  const prompt = buildCloseReportPrompt(task, "diff");
  assert.match(prompt, /код не читает/);
  assert.match(prompt, /НЕ упоминай файлы, функции/);
});

test("buildCloseReportPrompt caps the embedded diff", () => {
  const longDiff = "x".repeat(20_000);
  const prompt = buildCloseReportPrompt(task, longDiff);
  assert.ok(prompt.length < 12_000, `expected the diff to be capped, got a ${prompt.length}-char prompt`);
});
