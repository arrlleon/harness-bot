import { test } from "node:test";
import assert from "node:assert/strict";
import { CRITERIA_RULES, currentBehaviourClaims } from "./criteriaRules.js";

test("currentBehaviourClaims flags the criteria that claim behaviour stays as it is", () => {
  const criteria = [
    "Подписант получает 200 на скачивание",
    "Автор документа продолжает скачивать файл вне зависимости от папки — поведение не меняется.",
    "Участник с full по-прежнему может скачивать",
    "Поведение для одиночных документов не меняется",
    "Пакет без папки — кнопки видны, как раньше",
  ];
  assert.deepEqual(currentBehaviourClaims(criteria), [2, 3, 4, 5]);
});

test("currentBehaviourClaims: nothing to flag in plain new-behaviour criteria", () => {
  assert.deepEqual(currentBehaviourClaims(["Участник с add_only получает 403", "Поле isPersonalRouteParty есть в ленте"]), []);
});

test("CRITERIA_RULES ask to check current-behaviour claims, match the existing access check, and skip process criteria", () => {
  const text = CRITERIA_RULES.join("\n");
  assert.match(text, /проверь по коду/);
  assert.match(text, /так же, как его уже\s+проверяет код/);
  assert.match(text, /Не пиши критерии про процесс/);
});
