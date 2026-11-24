import { test } from "node:test";
import assert from "node:assert/strict";
import { CRITERIA_RULES, currentBehaviourClaims, ticketPlacesMissingFromPlan } from "./criteriaRules.js";

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

test("ticketPlacesMissingFromPlan lists files and endpoints the ticket names but the plan doesn't", () => {
  const description =
    "_Для разработчика:_ на {{client/documents/page.tsx}} гейты — {{canManageDocumentFolderActions(doc.folderId)}}; " +
    "нужен признак в {{GET /documents/feed}}; см. {{utils/route-participant.ts}} и {{/client/multi-signing/[batchId]}}.";
  const plan = "Добавлю поле в GET /documents/feed и гейты на client/documents/page.tsx, помощник в utils/route-participant.ts.";
  assert.deepEqual(ticketPlacesMissingFromPlan(description, plan), ["/client/multi-signing/[batchId]"]);
});

test("ticketPlacesMissingFromPlan ignores plain identifiers and a ticket without code refs", () => {
  assert.deepEqual(ticketPlacesMissingFromPlan("{{creatorId: null}} {{isPersonalRouteParty}}", "план"), []);
  assert.deepEqual(ticketPlacesMissingFromPlan("{{canManageDocumentFolderActions(doc.folderId / batch.folderId)}}", "план"), []);
  assert.deepEqual(ticketPlacesMissingFromPlan("просто текст", "план"), []);
});

test("CRITERIA_RULES ask to find sibling places with the same check", () => {
  assert.match(CRITERIA_RULES.join("\n"), /Найди все места с той же проверкой/);
});
