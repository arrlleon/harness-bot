import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReviewPrompt, parseReviewResponse } from "./review.js";
import type { TaskSpec } from "../types.js";

const task: TaskSpec = {
  id: "XEN-55",
  title: "Пагинация не работает для архивных записей",
  description: "Фильтр по статусу не учитывает архивные записи.",
  acceptanceCriteria: ["Архивные записи не попадают в выдачу по умолчанию"],
};

test("buildReviewPrompt includes the task, criteria, and diff", () => {
  const prompt = buildReviewPrompt(task, "diff --git a/x.ts b/x.ts\n+added line");
  assert.match(prompt, /XEN-55/);
  assert.match(prompt, /Архивные записи не попадают/);
  assert.match(prompt, /added line/);
  assert.match(prompt, /БЛОКИРУЮЩИЕ:/);
  assert.match(prompt, /ЗАМЕЧАНИЯ:/);
});

test("buildReviewPrompt handles a task with no frozen acceptance criteria", () => {
  const bare: TaskSpec = { ...task, acceptanceCriteria: [] };
  const prompt = buildReviewPrompt(bare, "diff");
  assert.match(prompt, /не зафиксированы для этой задачи/);
});

test("buildReviewPrompt caps the embedded diff", () => {
  const longDiff = "x".repeat(20_000);
  const prompt = buildReviewPrompt(task, longDiff);
  assert.ok(prompt.length < 12_000, `expected the diff to be capped, got a ${prompt.length}-char prompt`);
});

test("parseReviewResponse extracts both blocking and nonblocking findings", () => {
  const text = [
    "БЛОКИРУЮЩИЕ:",
    "- src/x.ts:10 — SQL-инъекция через неэкранированный параметр",
    "",
    "ЗАМЕЧАНИЯ:",
    "- src/y.ts:20 — можно вынести в отдельную функцию",
    "- src/z.ts:5 — не хватает комментария",
  ].join("\n");
  const findings = parseReviewResponse(text);
  assert.equal(findings.length, 3);
  assert.deepEqual(findings[0], { blocking: true, description: "src/x.ts:10 — SQL-инъекция через неэкранированный параметр" });
  assert.equal(findings[1].blocking, false);
  assert.equal(findings[2].blocking, false);
});

test("parseReviewResponse treats 'НЕТ' as no findings in that section", () => {
  const text = ["БЛОКИРУЮЩИЕ:", "НЕТ", "", "ЗАМЕЧАНИЯ:", "НЕТ"].join("\n");
  assert.deepEqual(parseReviewResponse(text), []);
});

test("parseReviewResponse returns empty (fail open) when the model doesn't follow the format", () => {
  const freeform = "Выглядит нормально, замечаний нет.";
  assert.deepEqual(parseReviewResponse(freeform), []);
});

test("parseReviewResponse handles only blocking findings with no nonblocking section reached", () => {
  const text = ["БЛОКИРУЮЩИЕ:", "- src/x.ts:1 — проблема", "", "ЗАМЕЧАНИЯ:", "НЕТ"].join("\n");
  const findings = parseReviewResponse(text);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].blocking, true);
});
