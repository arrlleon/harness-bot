import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAgentEnv } from "./claudeEngine.js";

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
