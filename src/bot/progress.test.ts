import { test } from "node:test";
import assert from "node:assert/strict";
import { fallbackActivity, cleanActivity, buildActivityPrompt } from "./progress.js";

test("fallbackActivity describes the agent's last file action", () => {
  assert.equal(fallbackActivity(["→ Чтение src/a.ts", "заметка агента", "→ Запись src/modules/x/admin.controller.ts"]), "создаю admin.controller.ts");
  assert.equal(fallbackActivity(["→ Правка src/b.ts", "→ Поиск по коду: \"foo\""]), "правлю b.ts");
  assert.equal(fallbackActivity(["только заметки"]), null);
});

test("cleanActivity keeps one short lower-cased line and rejects junk", () => {
  assert.equal(cleanActivity("«Создаю эндпоинт для списка клиентов».\nлишнее"), "создаю эндпоинт для списка клиентов");
  assert.equal(cleanActivity(""), null);
  assert.equal(cleanActivity("x".repeat(200)), null);
});

test("buildActivityPrompt carries the task title and only the most recent log lines", () => {
  const logs = Array.from({ length: 50 }, (_, i) => `→ Чтение file${i}.ts`);
  const prompt = buildActivityPrompt({ title: "Активные клиенты", phase: "iterating" }, logs);
  assert.match(prompt, /«Активные клиенты»/);
  assert.match(prompt, /file49\.ts/);
  assert.doesNotMatch(prompt, /file19\.ts/);
});
