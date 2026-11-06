import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWorkReportDocument, workReportFilename } from "./workReport.js";
import type { TaskSpec } from "../types.js";

const task: TaskSpec = {
  id: "XEN-55",
  title: "Пагинация не работает для архивных записей",
  description: "Фильтр по статусу не учитывает архивные записи.",
  acceptanceCriteria: [],
};

test("buildWorkReportDocument returns undefined when neither piece is available", () => {
  assert.equal(buildWorkReportDocument(task, {}), undefined);
});

test("buildWorkReportDocument includes the task header and both sections when both pieces exist", () => {
  const doc = buildWorkReportDocument(task, {
    closeReport: "Архивные записи теперь не теряются при фильтрации по статусу.",
    testingNotes: "ПРЕДУСЛОВИЯ:\n...\nШАГИ:\n1. ...",
  });
  assert.match(doc!, /XEN-55/);
  assert.match(doc!, /Пагинация не работает/);
  assert.match(doc!, /Что сделано:/);
  assert.match(doc!, /Архивные записи теперь не теряются/);
  assert.match(doc!, /Как проверить:/);
  assert.match(doc!, /ПРЕДУСЛОВИЯ:/);
});

test("buildWorkReportDocument works with only closeReport (testingNotes disabled or empty)", () => {
  const doc = buildWorkReportDocument(task, { closeReport: "Коротко о сути фикса." });
  assert.match(doc!, /Что сделано:/);
  assert.match(doc!, /Коротко о сути фикса/);
  assert.doesNotMatch(doc!, /Как проверить:/);
});

test("buildWorkReportDocument works with only testingNotes (closeReport disabled or empty)", () => {
  const doc = buildWorkReportDocument(task, { testingNotes: "ШАГИ:\n1. Открыть страницу" });
  assert.doesNotMatch(doc!, /Что сделано:/);
  assert.match(doc!, /Как проверить:/);
  assert.match(doc!, /Открыть страницу/);
});

test("workReportFilename names the file after the issue key", () => {
  assert.equal(workReportFilename("XEN-55"), "XEN-55-report.txt");
});
