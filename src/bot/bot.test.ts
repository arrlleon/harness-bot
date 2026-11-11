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
  const text = composeNeedsHumanText({ issueKey: "XEN-540", reason: "review_blocked: " + "длинное замечание ".repeat(400), costUsd: 13.02 }, "diff --git a/x b/x\n" + "+line\n".repeat(5000));
  assert.ok(text.length <= 4000, `got ${text.length}`);
  assert.match(text, /XEN-540/);
  assert.match(text, /diff --git/);
});

test("composeNeedsHumanText says so when the diff is empty, and is just the header without one", () => {
  assert.match(composeNeedsHumanText({ issueKey: "X-1", reason: "stuck", costUsd: 1 }, "  "), /diff пустой/);
  assert.doesNotMatch(composeNeedsHumanText({ issueKey: "X-1", reason: "stuck", costUsd: 1 }, null), /diff/);
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
  assert.match(plain, /X-1: fix a\.b \(now\)/);
  assert.doesNotMatch(plain, /\\/);
  assert.doesNotMatch(plain, /\|\|/);
});
