import { test } from "node:test";
import assert from "node:assert/strict";
import { escalateScopeFindings, ESCALATION_NOTE, needsHumanDecision } from "./reviewEscalation.js";

test("escalateScopeFindings blocks the XEN-1025 note that called widened access nonblocking", () => {
  const note =
    "documents.service.ts (`assertActorCanDownloadDocument`, ветка `creatorId === actor.id`) — это новое поведение, " +
    "а не только фикс подписанта. Раньше автор без членства в папке получал отказ. Критерий 4 назвал его «без изменений», " +
    "хотя фактически доступ расширен. Скорее всего, это намеренно.";
  const [f] = escalateScopeFindings([{ blocking: false, description: note }]);
  assert.equal(f.blocking, true);
  assert.ok(f.description.startsWith(ESCALATION_NOTE));
  assert.ok(f.description.endsWith(note));
});

test("escalateScopeFindings catches the other wordings for widened rights or scope", () => {
  for (const d of [
    "это расширяет права участника с add_only",
    "расширение доступа для автора",
    "ослабляет защиту TASK-113",
    "эскалация привилегий через PATCH",
    "правка за рамками задачи: переименование заодно",
    "the change widens access for the creator",
    "this refactor is out of scope",
  ]) {
    assert.equal(escalateScopeFindings([{ blocking: false, description: d }])[0].blocking, true, d);
  }
});

test("escalateScopeFindings leaves plain observations and blocking findings alone", () => {
  const plain = [
    "личный назначенец получает доступ ко всему документу независимо от статуса шага",
    "для одного creator.id подгружается целая сущность Users через join",
    "NotFoundException из findAccessible приравнен к отказу по папке",
  ].map((description) => ({ blocking: false, description }));
  assert.deepEqual(escalateScopeFindings(plain), plain);

  const blocking = [{ blocking: true, description: "новое поведение без теста" }];
  assert.deepEqual(escalateScopeFindings(blocking), blocking);
});

test("needsHumanDecision stops only on an escalated finding, not on an ordinary blocking one", () => {
  const escalated = escalateScopeFindings([{ blocking: false, description: "фактически доступ расширен" }]);
  assert.equal(needsHumanDecision(escalated), true);
  assert.equal(needsHumanDecision([{ blocking: true, description: "SQL-инъекция в фильтре" }]), false);
  assert.equal(needsHumanDecision([]), false);
});
