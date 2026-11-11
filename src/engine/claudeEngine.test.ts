import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAgentEnv, pickResultText, callContextTokens } from "./claudeEngine.js";

test("buildAgentEnv strips every harness secret, leaving everything else untouched", () => {
  const source = {
    PATH: "/usr/bin",
    HOME: "/home/x",
    JIRA_PAT: "jira-secret",
    GITLAB_TOKEN: "gitlab-secret",
    TELEGRAM_BOT_TOKEN: "telegram-secret",
  };
  const env = buildAgentEnv(source);
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/home/x");
  assert.equal(env.JIRA_PAT, undefined);
  assert.equal(env.GITLAB_TOKEN, undefined);
  assert.equal(env.TELEGRAM_BOT_TOKEN, undefined);
});

test("buildAgentEnv does not mutate the source object", () => {
  const source = { JIRA_PAT: "jira-secret" };
  buildAgentEnv(source);
  assert.equal(source.JIRA_PAT, "jira-secret");
});

test("buildAgentEnv works on an env with none of the secret keys present", () => {
  const env = buildAgentEnv({ PATH: "/usr/bin" });
  assert.deepEqual(env, { PATH: "/usr/bin" });
});

// Reproduced live (XEN-540, 2026-11-10): a --max-budget-usd cutoff mid-turn left the
// CLI's own `result` field empty even though the model had already written a full
// status report as its last assistant text turn.
test("pickResultText prefers the CLI's own result when it said something", () => {
  assert.equal(pickResultText("done, see diff", "ignored fallback"), "done, see diff");
});

test("pickResultText falls back to the last assistant text when result is empty", () => {
  assert.equal(pickResultText("", "Бюджет сессии исчерпан, поэтому останавливаюсь"), "Бюджет сессии исчерпан, поэтому останавливаюсь");
});

test("pickResultText falls back when result is only whitespace", () => {
  assert.equal(pickResultText("   \n", "последний статус"), "последний статус");
});

test("pickResultText returns empty when neither has anything to say", () => {
  assert.equal(pickResultText("", ""), "");
});

// Reproduced live (XEN-540): the result event's usage is summed across every API call
// in a turn (8783k for a turn whose real context peaked at 187k) — context size has to
// come from one call's own usage instead.
test("callContextTokens sums one API call's input, cache_read and cache_creation", () => {
  assert.equal(callContextTokens({ input_tokens: 10, cache_read_input_tokens: 14959, cache_creation_input_tokens: 8189, output_tokens: 4 }), 23158);
});

test("callContextTokens is 0 for a missing or all-zero (synthetic message) usage", () => {
  assert.equal(callContextTokens(undefined), 0);
  assert.equal(callContextTokens({ input_tokens: 0, output_tokens: 0 }), 0);
});
