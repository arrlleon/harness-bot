import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeMarkdownV2, formatProposal, formatProposalFitted, fitTelegram, plainFromMarkdownV2, composeNeedsHumanText } from "./bot.js";
import type { Proposal } from "../queue.js";

test("escapeMarkdownV2 escapes every reserved character", () => {
  const raw = "a(b)c[d]e.f-g!h";
  const escaped = escapeMarkdownV2(raw);
  assert.equal(escaped, "a\\(b\\)c\\[d\\]e\\.f\\-g\\!h");
});

// Reproduced live, twice in a row against the real Telegram API: first "Character '('
// is reserved" (static strings in formatProposal/formatCostEstimate had literal,
// unescaped parentheses that never went through escapeMarkdownV2), then — once those
// were fixed — "can't find end of Strikethrough entity" (the "~" used as a literal
// approx sign in formatCostEstimate's cost/duration is ALSO MarkdownV2's strikethrough
// delimiter, and was never escaped either). Every "(" / ")" / "~" in the rendered
// output must be backslash-escaped; these are the characters formatProposal never has
// a legitimate unescaped use for (unlike "*"/">"/"|", which it deliberately uses for
// bold/blockquote markup).
function assertReservedCharsEscaped(text: string): void {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(" || text[i] === ")" || text[i] === "~") {
      assert.equal(text[i - 1], "\\", `unescaped "${text[i]}" at index ${i} in: ${text}`);
    }
  }
}

const baseProposal: Proposal = {
  issueKey: "XEN-1",
  title: "Some title",
  repo: "backend",
  descriptionShort: "desc",
  plan: "plan",
  acceptanceCriteria: [],
  costUsd: 0.1234,
  costEstimate: null,
};

test("formatProposal escapes reserved chars in the cost-estimate line (no duration)", () => {
  const text = formatProposal({
    ...baseProposal,
    costEstimate: { sampleSize: 5, avgCostUsd: 1, medianCostUsd: 1.5, avgDurationMs: null, medianDurationMs: null },
  });
  assertReservedCharsEscaped(text);
});

test("formatProposal escapes reserved chars in the cost-estimate line (with duration)", () => {
  const text = formatProposal({
    ...baseProposal,
    costEstimate: { sampleSize: 5, avgCostUsd: 1, medianCostUsd: 1.5, avgDurationMs: 60_000, medianDurationMs: 90_000 },
  });
  assertReservedCharsEscaped(text);
});

test("formatProposal escapes reserved chars in the 'no acceptance criteria' fallback line", () => {
  const text = formatProposal({ ...baseProposal, acceptanceCriteria: [] });
  assertReservedCharsEscaped(text);
});

test("formatProposal escapes reserved chars in the acceptance-criteria header line", () => {
  const text = formatProposal({ ...baseProposal, acceptanceCriteria: ["some criterion"] });
  assertReservedCharsEscaped(text);
});

// Audit finding (2026-11-12): Telegram rejects anything over 4096 characters, and a
// rejected message takes its buttons with it — the task then waits on a human who was
// never told. Every outgoing text has to fit.
test("fitTelegram leaves short text alone and marks what it cut", () => {
  assert.equal(fitTelegram("коротко"), "коротко");
  const cut = fitTelegram("x".repeat(10_000));
  assert.ok(cut.length <= 4000);
  assert.match(cut, /обрезано/);
});

test("composeNeedsHumanText always fits, however long the reason and the diff are", () => {
  const diff = Array.from({ length: 40 }, (_, i) => `diff --git a/src/f${i}.ts b/src/f${i}.ts\n` + "+line\n".repeat(200)).join("");
  const text = composeNeedsHumanText({ issueKey: "XEN-540", reason: "review_blocked: " + "длинное замечание ".repeat(400), costUsd: 13.02 }, diff);
  assert.ok(text.length <= 4000, `got ${text.length}`);
  assert.match(text, /XEN-540/);
  // A file list with totals, never the raw diff.
  assert.match(text, /40 файл\(ов\), \+8000 −0/);
  assert.doesNotMatch(text, /diff --git/);
});

test("composeNeedsHumanText: no changes means no 'open MR' option; no diff at all means just the header", () => {
  const empty = composeNeedsHumanText({ issueKey: "X-1", reason: "stuck", costUsd: 1 }, "  ");
  assert.match(empty, /изменений в коде нет/);
  assert.doesNotMatch(empty, /Открыть MR/);
  assert.doesNotMatch(composeNeedsHumanText({ issueKey: "X-1", reason: "stuck", costUsd: 1 }, null), /Сделано/);
});

// XEN-381, live: the raw git/harness reason was the whole message.
test("composeNeedsHumanText explains a stop in plain words and never shows the raw reason", () => {
  const reason = "rebase_conflict (dev moved on while this was paused, and the two don't merge cleanly): error: Entry 'docs/a.md' not uptodate. Cannot merge.";
  const text = composeNeedsHumanText({ issueKey: "XEN-381", reason, costUsd: 10.87 }, "diff --git a/docs/a.md b/docs/a.md\nnew file mode 100644\n+x\n", { canContinue: false, title: "Активные клиенты", budgetUsd: 20 });
  assert.match(text, /^⚠️ НУЖНО ТВОЁ РЕШЕНИЕ · XEN-381\nАктивные клиенты/);
  assert.match(text, /Что случилось: Пока задача стояла на паузе/);
  assert.match(text, /Потрачено: \$10\.87 из \$20\.00/);
  assert.match(text, /новый docs\/a\.md/);
  assert.doesNotMatch(text, /rebase_conflict|uptodate|Cannot merge/);
  assert.doesNotMatch(text, /Доработать/);
  assert.match(composeNeedsHumanText({ issueKey: "X", reason: "context_budget: ~225k", costUsd: 1 }, "", { canContinue: true }), /Доработать/);
});

test("formatProposalFitted shrinks an oversized proposal under Telegram's limit and keeps the key", () => {
  const big: Proposal = {
    issueKey: "XEN-540",
    title: "[backend] Изоляция прав (подпапка)",
    repo: "backend",
    descriptionShort: "описание.",
    plan: "План: поменять `hasTreeMembership` (и не только). ".repeat(120),
    acceptanceCriteria: Array.from({ length: 7 }, (_, i) => `Критерий ${i + 1}: ` + "проверяемое условие. ".repeat(40)),
    costUsd: 0.5,
    costEstimate: null,
  };
  assert.ok(formatProposal(big).length > 4096, "the fixture has to be genuinely too long");
  const fitted = formatProposalFitted(big);
  assert.ok(fitted.length <= 4000, `got ${fitted.length}`);
  assert.match(fitted, /XEN\\-540/);
});

test("formatProposalFitted leaves a normal proposal exactly as formatProposal made it", () => {
  const p: Proposal = { issueKey: "X-1", title: "t", repo: "backend", descriptionShort: "d", plan: "p", acceptanceCriteria: ["c"], costUsd: 0.1, costEstimate: null };
  assert.equal(formatProposalFitted(p), formatProposal(p));
});

test("plainFromMarkdownV2 gives readable plain text back from an escaped proposal", () => {
  const p: Proposal = { issueKey: "X-1", title: "fix a.b (now)", repo: "backend", descriptionShort: "d", plan: "use `x`", acceptanceCriteria: ["c-1"], costUsd: 0.1, costEstimate: null };
  const plain = plainFromMarkdownV2(formatProposal(p));
  assert.match(plain, /📋 ПРЕДЛОЖЕНИЕ · X-1\nfix a\.b \(now\)/);
  assert.doesNotMatch(plain, /\\/);
  assert.doesNotMatch(plain, /\|\|/);
});

test("formatProposal is short: category line, where, one-line plan, criteria count; the rest collapsed", () => {
  const p: Proposal = {
    issueKey: "XEN-381",
    title: "Активные клиенты",
    repo: "backend",
    descriptionShort: "длинное описание тикета ".repeat(20),
    plan: "Эндпоинта на бэкенде нет. Добавлю контроллер и сервис. " + "Подробности реализации. ".repeat(40) + "\n\nРепозиторий фронтенд не трогаю: страница уже есть в dev",
    acceptanceCriteria: ["a", "b", "c"],
    costUsd: 1.17,
    costEstimate: null,
  };
  const text = formatProposal(p);
  const visible = text.split("\n**>")[0];
  assert.ok(visible.length < 700, `visible part is ${visible.length} chars`);
  assert.match(visible, /📋 ПРЕДЛОЖЕНИЕ · \*XEN\\-381\*/);
  assert.match(visible, /Где: бэкенд/);
  assert.match(visible, /Не трогаю: фронтенд — страница уже есть в dev/);
  assert.match(visible, /Критерии приёмки: 3/);
  assert.doesNotMatch(visible, /длинное описание/);
  assert.match(text, /Подробности реализации/);
  assertReservedCharsEscaped(text);
});

test("formatProposal prefers the analysis's plain summary over the plan's first sentences", () => {
  const p: Proposal = { ...baseProposal, plan: "Технический план с `путями/к/файлам.ts`.", summary: "добавлю список активных клиентов" };
  const visible = plainFromMarkdownV2(formatProposal(p)).split("💡")[0];
  assert.match(visible, /Что сделаю: добавлю список активных клиентов/);
  assert.doesNotMatch(visible, /путями/);
});
