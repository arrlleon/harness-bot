import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReviewPrompt, parseReviewResponse, buildReviewFixPrompt, formatReviewRound, isReviewResponseWellFormed } from "./review.js";
import type { ReviewFinding, TaskSpec } from "../types.js";

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
  const longDiff = "x".repeat(200_000);
  const prompt = buildReviewPrompt(task, longDiff);
  assert.ok(prompt.length < 65_000, `expected the diff to be capped, got a ${prompt.length}-char prompt`);
});

// Reproduced live (XEN-540): with the old 8000-char cap the reviewer saw two files of
// a ten-file diff and approved the rest unseen.
test("buildReviewPrompt lists every changed file when the diff had to be truncated", () => {
  const body = "x".repeat(40_000);
  const diff = `diff --git a/src/a.ts b/src/a.ts\n${body}\ndiff --git a/src/b.ts b/src/b.ts\n${body}`;
  const prompt = buildReviewPrompt(task, diff);
  assert.match(prompt, /diff выше обрезан/);
  assert.match(prompt, /- src\/a\.ts/);
  assert.match(prompt, /- src\/b\.ts/);
});

test("isReviewResponseWellFormed tells an explicit 'НЕТ' apart from an answer in no known format", () => {
  assert.equal(isReviewResponseWellFormed("БЛОКИРУЮЩИЕ:\nНЕТ\n\nЗАМЕЧАНИЯ:\nНЕТ"), true);
  assert.equal(isReviewResponseWellFormed("Looks good to me, ship it."), false);
  assert.equal(isReviewResponseWellFormed("You've hit your session limit"), false);
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

test("buildReviewFixPrompt lists every blocking finding and invites pushback", () => {
  const blocking: ReviewFinding[] = [
    { blocking: true, description: "src/x.ts:10 — SQL-инъекция" },
    { blocking: true, description: "src/y.ts:5 — не обработан null" },
  ];
  const prompt = buildReviewFixPrompt(blocking);
  assert.match(prompt, /SQL-инъекция/);
  assert.match(prompt, /не обработан null/);
  assert.match(prompt, /не игнорируй его молча/);
});

test("formatReviewRound reconstructs the БЛОКИРУЮЩИЕ/ЗАМЕЧАНИЯ shape from parsed findings", () => {
  const findings: ReviewFinding[] = [
    { blocking: true, description: "блокирующая проблема" },
    { blocking: false, description: "просто замечание" },
  ];
  const text = formatReviewRound(findings, undefined);
  assert.match(text, /БЛОКИРУЮЩИЕ:\n- блокирующая проблема/);
  assert.match(text, /ЗАМЕЧАНИЯ:\n- просто замечание/);
});

test("formatReviewRound writes НЕТ for an empty section, not an empty list", () => {
  const text = formatReviewRound([], undefined);
  assert.match(text, /БЛОКИРУЮЩИЕ:\nНЕТ/);
  assert.match(text, /ЗАМЕЧАНИЯ:\nНЕТ/);
});

test("formatReviewRound reports the turn's own failure reason instead of guessing at findings", () => {
  const text = formatReviewRound([], "ход завершился ошибкой: timeout");
  assert.match(text, /Ревью не удалось провести: ход завершился ошибкой: timeout/);
});
