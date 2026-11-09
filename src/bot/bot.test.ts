import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeMarkdownV2, formatProposal } from "./bot.js";
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
