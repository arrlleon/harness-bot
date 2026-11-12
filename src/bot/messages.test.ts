import { test } from "node:test";
import assert from "node:assert/strict";
import { explainStop, diffStats, composeProgressText, headline } from "./messages.js";

test("explainStop turns every known stop code into a sentence without the code itself", () => {
  const reasons = [
    "context_budget: контекст сессии ~225k токенов, не прошли гейты: test, acceptance",
    "max_budget",
    "max_iterations",
    "stuck (same failure repeated in: typecheck)",
    "review_blocked после 2 раунд(ов) с разработчиком: src/a.ts:1 — SQL-инъекция",
    "gate_integrity_violation: .only added",
    "agent_error: You've hit your limit",
    "rebase_conflict (dev moved on ...): error: Entry 'x' not uptodate",
    "push/MR failed: GitLab MR creation failed: 403",
    "остановлено вручную (/kill)",
    "сбой харнесса: TypeError: x is undefined",
  ];
  for (const reason of reasons) {
    const { why } = explainStop(reason);
    assert.doesNotMatch(why, /context_budget|max_budget|max_iterations|stuck|review_blocked|gate_integrity|agent_error|rebase_conflict|push\/MR|uptodate|TypeError/, `${reason} -> ${why}`);
    assert.ok(why.length > 10);
  }
  assert.match(explainStop(reasons[0]).why, /Не проходят проверки: тесты, приёмочный тест/);
  assert.match(explainStop(reasons[4]).why, /SQL-инъекция/);
  assert.equal(explainStop(reasons[0]).continueUseful, true);
  assert.equal(explainStop(reasons[7]).continueUseful, false);
});

test("explainStop names the half of a cross-repo task and a failed resume", () => {
  assert.match(explainStop("backend: max_iterations").why, /^Бэкенд-часть: агент исчерпал попытки/);
  assert.match(explainStop("frontend: stuck (same failure repeated in: test) (backend already opened: https://x/1)").why, /^Фронтенд-часть \(бэкенд уже в MR\): агент два раза/);
  assert.match(explainStop("context_budget: ~200k · продолжение не удалось: boom").why, /Попытка продолжить тоже не удалась\.$/);
  assert.match(explainStop("что-то новое").why, /необычной причине/);
});

test("diffStats counts files, new files and lines without the +++/--- headers", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "-old",
    "+new",
    "+more",
    "diff --git a/src/b.ts b/src/b.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/b.ts",
    "+x",
  ].join("\n");
  const stats = diffStats(diff);
  assert.equal(stats.files.length, 2);
  assert.deepEqual(stats.files[1], { path: "src/b.ts", added: 1, removed: 0, isNew: true });
  assert.equal(stats.added, 3);
  assert.equal(stats.removed, 1);
});

test("composeProgressText leads with what is happening now, then stage, attempt, time and money", () => {
  const text = composeProgressText({
    issueKey: "XEN-381",
    title: "Активные клиенты",
    phaseLabel: "пишу код",
    activity: "создаю эндпоинт для списка активных клиентов",
    iteration: 1,
    maxIterations: 5,
    costUsd: 6.2,
    budgetUsd: 20,
    startedAt: "2026-11-12T06:00:00.000Z",
    now: new Date("2026-11-12T06:15:00.000Z"),
  });
  const lines = text.split("\n");
  assert.equal(lines[0], headline("working", "XEN-381"));
  assert.equal(lines[3], "Сейчас: создаю эндпоинт для списка активных клиентов");
  assert.match(text, /Этап: пишу код/);
  assert.match(text, /Попытка: 1 из 5/);
  assert.match(text, /Идёт 15 мин · потрачено \$6\.20 из \$20\.00/);
  assert.match(text, /обновлено в 11:15/);
});
