import { test } from "node:test";
import assert from "node:assert/strict";
import { buildScopePrompt, combineVerdicts, parseNoChangesSignal, parseRepoVerdict, stripPreamble } from "./repoScope.js";
import type { TaskSpec } from "../types.js";

const task: TaskSpec = {
  id: "XEN-600",
  title: "[frontend] Показать дату подписания в карточке документа",
  description: "В карточке документа нужна дата подписания.",
  acceptanceCriteria: [],
};

const PLAN = ["ПЛАН:", "Добавить поле signedAt в DTO.", "", "КРИТЕРИИ ПРИЁМКИ:", "- DTO содержит signedAt", "- поле заполняется при подписании"].join("\n");

test("parseNoChangesSignal reads the one-line 'nothing to change here' answer and its reason", () => {
  assert.equal(parseNoChangesSignal("ИЗМЕНЕНИЯ: НЕ НУЖНЫ — эндпоинт уже отдаёт signedAt"), "эндпоинт уже отдаёт signedAt");
  assert.equal(parseNoChangesSignal("  изменения: не нужны. Задача чисто визуальная\nещё текст"), "Задача чисто визуальная");
  assert.equal(parseNoChangesSignal("ИЗМЕНЕНИЯ: НЕ НУЖНЫ"), "причина не указана");
});

// The phrase inside an ordinary plan must not drop the repo from the task.
test("parseNoChangesSignal ignores the phrase anywhere but the start of the answer", () => {
  assert.equal(parseNoChangesSignal(PLAN), null);
  assert.equal(parseNoChangesSignal("ПЛАН:\nПоправить сервис. Изменения: не нужны в схеме БД."), null);
});

test("parseRepoVerdict turns a plan into an in-scope verdict with its criteria", () => {
  const verdict = parseRepoVerdict(PLAN, 0.4);
  assert.equal(verdict.needsChanges, true);
  assert.match(verdict.plan, /signedAt/);
  assert.deepEqual(verdict.acceptanceCriteria, ["DTO содержит signedAt", "поле заполняется при подписании"]);
  assert.equal(verdict.costUsd, 0.4);
});

// An answer in no known format still means "this repo has something to say" — it stays
// in scope (plan only, no criteria) rather than being silently dropped.
test("parseRepoVerdict keeps a free-form answer in scope", () => {
  const verdict = parseRepoVerdict("Нужно поправить сервис документов.", 0.1);
  assert.equal(verdict.needsChanges, true);
  assert.deepEqual(verdict.acceptanceCriteria, []);
});

test("combineVerdicts: both repos need changes -> cross, with repo-prefixed plan and criteria", () => {
  const backend = parseRepoVerdict(PLAN, 0.4);
  const frontend = parseRepoVerdict("ПЛАН:\nВывести дату в карточке.\n\nКРИТЕРИИ ПРИЁМКИ:\n- дата видна в карточке", 0.3);
  const result = combineVerdicts(backend, frontend);
  assert.equal(result.scope, "cross");
  assert.match(result.plan, /^\[backend\]\n[\s\S]*\n\n\[frontend\]\n/);
  assert.deepEqual(result.acceptanceCriteria, [
    "[backend] DTO содержит signedAt",
    "[backend] поле заполняется при подписании",
    "[frontend] дата видна в карточке",
  ]);
  assert.ok(Math.abs(result.costUsd - 0.7) < 1e-9);
  assert.deepEqual(result.skippedRepos, []);
});

// The case the tag used to get wrong: tagged [frontend], but the code says backend only.
test("combineVerdicts: one repo needs changes -> that repo alone, the other listed with its reason", () => {
  const backend = parseRepoVerdict(PLAN, 0.4);
  const frontend = parseRepoVerdict("ИЗМЕНЕНИЯ: НЕ НУЖНЫ — карточка уже рендерит все поля DTO", 0.2);
  const result = combineVerdicts(backend, frontend);
  assert.equal(result.scope, "backend");
  assert.deepEqual(result.acceptanceCriteria, ["DTO содержит signedAt", "поле заполняется при подписании"]);
  assert.deepEqual(result.skippedRepos, [{ repo: "frontend", reason: "карточка уже рендерит все поля DTO" }]);

  const mirrored = combineVerdicts(frontend, backend);
  assert.equal(mirrored.scope, "frontend");
  assert.deepEqual(mirrored.skippedRepos, [{ repo: "backend", reason: "карточка уже рендерит все поля DTO" }]);
});

test("combineVerdicts: neither repo needs changes -> no scope, both reasons kept, cost still counted", () => {
  const none = (reason: string) => parseRepoVerdict(`ИЗМЕНЕНИЯ: НЕ НУЖНЫ — ${reason}`, 0.2);
  const result = combineVerdicts(none("уже сделано"), none("не касается"));
  assert.equal(result.scope, null);
  assert.equal(result.skippedRepos.length, 2);
  assert.ok(Math.abs(result.costUsd - 0.4) < 1e-9);
});

test("buildScopePrompt names both repos, points at the other one's path and tells the model to ignore tags", () => {
  const prompt = buildScopePrompt(task, "frontend", "/repos/back-ai", "");
  assert.match(prompt, /XEN-600/);
  assert.match(prompt, /Ты отвечаешь за frontend/);
  assert.match(prompt, /backend \(бэкенд\), лежит в \/repos\/back-ai/);
  assert.match(prompt, /Теги вида \[backend\]\/\[frontend\] в заголовке не учитывай/);
  assert.match(prompt, /ИЗМЕНЕНИЯ: НЕ НУЖНЫ/);
  assert.match(prompt, /КРИТЕРИИ ПРИЁМКИ:/);
});

test("parseRepoVerdict drops a leading 'ИЗМЕНЕНИЯ: НУЖНЫ' line the model adds on its own", () => {
  const verdict = parseRepoVerdict(`ИЗМЕНЕНИЯ: НУЖНЫ\n\n${PLAN}`, 0.2);
  assert.equal(verdict.needsChanges, true);
  assert.equal(verdict.plan, "Добавить поле signedAt в DTO.");
});

// XEN-632, live: reasoning first, signal line last — the frontend was put in scope.
test("parseNoChangesSignal finds the signal on a later line after the model's reasoning", () => {
  const text = "Это чисто архитектурный фикс внутри back-ai.\n\nИЗМЕНЕНИЯ: НЕ НУЖНЫ — внутренний рефакторинг слоёв";
  assert.equal(parseNoChangesSignal(text), "внутренний рефакторинг слоёв");
  assert.equal(parseRepoVerdict(text, 0.1).needsChanges, false);
});

test("parseNoChangesSignal ignores a signal line inside a real plan with criteria", () => {
  const text = `${PLAN}\nИЗМЕНЕНИЯ: НЕ НУЖНЫ — в миграциях`;
  assert.equal(parseNoChangesSignal(text), null);
});

test("stripPreamble drops reasoning written before ПЛАН:, and the parsed plan starts at the plan", () => {
  const text = `Подтверждено по ADR-0031.\n\nТеперь всё подтверждено кодом.\n\n${PLAN}`;
  assert.match(stripPreamble(text), /^ПЛАН:/);
  assert.equal(parseRepoVerdict(text, 0.1).plan, "Добавить поле signedAt в DTO.");
  assert.equal(stripPreamble("без метки"), "без метки");
});

test("parseRepoVerdict reads the plain one-line summary and keeps it out of the plan", () => {
  const verdict = parseRepoVerdict(`КОРОТКО: «добавлю на бэкенде список активных клиентов».\n\n${PLAN}`, 0.2);
  assert.equal(verdict.summary, "добавлю на бэкенде список активных клиентов");
  assert.doesNotMatch(verdict.plan, /КОРОТКО/);
  assert.equal(parseRepoVerdict(PLAN, 0.2).summary, "");
});

test("combineVerdicts carries the summary: one repo as is, both repos labelled", () => {
  const back = parseRepoVerdict(`КОРОТКО: добавлю поле\n\n${PLAN}`, 0.1);
  const front = parseRepoVerdict(`КОРОТКО: покажу поле в карточке\n\n${PLAN}`, 0.1);
  assert.equal(combineVerdicts(back, front).summary, "бэкенд — добавлю поле; фронтенд — покажу поле в карточке");
  const none = parseRepoVerdict("ИЗМЕНЕНИЯ: НЕ НУЖНЫ — нечего", 0.1);
  assert.equal(combineVerdicts(back, none).summary, "добавлю поле");
});
