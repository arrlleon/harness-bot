import "dotenv/config";
import type { GateSpec } from "./types.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export interface RepoConfig {
  path: string;
  gates: GateSpec[];
  gitlabProjectPath: string;
  // How to run exactly one acceptance-test file, and what extension this repo's test
  // runner discovers (jest: .spec.ts via testRegex; vitest: .test.ts via `include`).
  // Deliberately `npx <runner>` rather than the repo's own `yarn test` script —
  // reproduced live: a plain `yarn test` run on front-ai silently rewrote
  // package.json's packageManager field as a side effect, which would otherwise leak
  // into the task's own commit on every gate run. `npx` sidesteps yarn entirely.
  acceptanceRunner: string;
  acceptanceTestExt: string;
}

// typecheck/lint run before test (cheap, fast signal first) and build runs last
// (slowest, most redundant with typecheck). Each is opt-in via its own env var so
// existing setups with only BACKEND_VERIFY_CMD/FRONTEND_VERIFY_CMD configured keep
// working unchanged — "test" is the only gate with a hardcoded default command.
function buildGates(prefix: "BACKEND" | "FRONTEND", defaultTestCommand: string): GateSpec[] {
  const gates: GateSpec[] = [];
  const typecheck = process.env[`${prefix}_GATE_TYPECHECK`];
  if (typecheck) gates.push({ name: "typecheck", command: typecheck });
  const lint = process.env[`${prefix}_GATE_LINT`];
  if (lint) gates.push({ name: "lint", command: lint });
  gates.push({ name: "test", command: process.env[`${prefix}_VERIFY_CMD`] ?? defaultTestCommand });
  const build = process.env[`${prefix}_GATE_BUILD`];
  if (build) gates.push({ name: "build", command: build });
  return gates;
}

// Single source of truth for "env vars the spawned `claude` child process must never
// see" (claudeEngine.ts strips exactly these before spawning). Every implement/review/
// memory/testing-notes turn gets Bash by default — child_process.spawn otherwise
// inherits the full parent env, so a prompt-injected ticket ("also run curl ... -d
// \"$GITLAB_TOKEN\"") would succeed trivially with no file access needed. Kept here,
// next to where each one is actually read, so a newly added secret can't silently miss
// the denylist the way it would if the list lived somewhere unrelated.
export const SECRET_ENV_VARS = ["JIRA_PAT", "GITLAB_TOKEN", "TELEGRAM_BOT_TOKEN"] as const;

export const config = {
  jira: {
    baseUrl: requireEnv("JIRA_BASE_URL"),
    token: requireEnv("JIRA_PAT"),
    inProgressStatus: process.env.JIRA_IN_PROGRESS_STATUS ?? "В работе",
    reviewStatus: process.env.JIRA_REVIEW_STATUS ?? "Review",
    // Only for the /retry transition — JQL's `status = "<name>"` field validator
    // rejected this exact value for this project even though it's a real global
    // status and shows up on issues' own `status.name`; transitions (matched by
    // `to.name` on the issue's own available-transitions list) aren't affected.
    todoStatus: process.env.JIRA_TODO_STATUS ?? "Сделать",
    projectKey: process.env.JIRA_PROJECT_KEY ?? "XEN",
  },
  gitlab: {
    baseUrl: process.env.GITLAB_BASE_URL ?? "https://gitlab.digal.kz",
    token: process.env.GITLAB_TOKEN ?? "",
    targetBranch: process.env.GITLAB_TARGET_BRANCH ?? "dev",
  },
  repos: {
    backend: {
      path: process.env.BACKEND_REPO_PATH ?? "",
      gates: buildGates("BACKEND", "yarn test"),
      gitlabProjectPath: process.env.BACKEND_GITLAB_PROJECT ?? "saqr/back-ai",
      acceptanceRunner: process.env.BACKEND_ACCEPTANCE_RUNNER ?? "npx jest",
      acceptanceTestExt: process.env.BACKEND_ACCEPTANCE_TEST_EXT ?? "spec.ts",
    },
    frontend: {
      path: process.env.FRONTEND_REPO_PATH ?? "",
      gates: buildGates("FRONTEND", "yarn test"),
      gitlabProjectPath: process.env.FRONTEND_GITLAB_PROJECT ?? "saqr/front-ai",
      acceptanceRunner: process.env.FRONTEND_ACCEPTANCE_RUNNER ?? "npx vitest run",
      acceptanceTestExt: process.env.FRONTEND_ACCEPTANCE_TEST_EXT ?? "test.ts",
    },
  } satisfies Record<string, RepoConfig>,
  // No role here used an explicit --model before — every turn silently inherited
  // whatever the `claude` CLI's own default happened to be. Pinned per role instead:
  // the chat classifier only ever picks a keyword, doesn't need a strong model to do
  // it fast and cheap (it's the ONE role that fires on every stray Telegram message,
  // not just once per ticket); propose only reads code and writes a short plan;
  // implement is what actually has to get the fix right across up to 5 iterations,
  // where the cost of a cheaper model giving a worse diff dwarfs the price difference.
  models: {
    chat: process.env.CHAT_MODEL ?? "claude-haiku-4-5-20251001",
    propose: process.env.PROPOSE_MODEL ?? "claude-sonnet-5",
    implement: process.env.IMPLEMENT_MODEL ?? "claude-opus-5",
    // Writing a good acceptance test needs real codebase understanding (test-module
    // setup, mocking conventions) but is a single, bounded turn, not an open-ended
    // multi-iteration loop — Sonnet, same weight class as propose.
    acceptance: process.env.ACCEPTANCE_MODEL ?? "claude-sonnet-5",
    // Deciding whether something is durable-fact-worthy and merging it cleanly into
    // an existing notes file needs real judgment (avoid noise/dupes) but is one
    // read-only turn per successful task, not a loop — Sonnet, same tier as propose.
    memory: process.env.MEMORY_MODEL ?? "claude-sonnet-5",
    // Catching what gates can't (architecture, security, edge cases) needs real
    // capability, not just a bounded turn to save cost — Opus, same tier as implement.
    review: process.env.REVIEW_MODEL ?? "claude-opus-5",
    // Writing a tester's walkthrough from a diff + task description is the same
    // bounded-judgment shape as propose/acceptance/memory, not an open-ended loop —
    // Sonnet, same tier as those.
    testing: process.env.TESTING_MODEL ?? "claude-sonnet-5",
  },
  // On by default — this is the whole point of freezing acceptance criteria at
  // propose time. Kept as a single kill switch (not per-repo) so it can be turned
  // off instantly without a redeploy if the extra turn's cost/time ever becomes a
  // problem, without touching the gate/model config above it.
  acceptanceTestsEnabled: (process.env.ACCEPTANCE_TESTS_ENABLED ?? "true") !== "false",
  // Same shape: on by default, one kill switch. Adds one extra read-only turn per
  // *successful* task (not per iteration) — cheap relative to propose/acceptance.
  memoryEnabled: (process.env.MEMORY_ENABLED ?? "true") !== "false",
  // Same shape, same default. A blocking finding here routes through the existing
  // needs_human flow instead of pushing — same mechanical "gates matter" principle,
  // just for the category of problem gates structurally can't catch.
  reviewEnabled: (process.env.REVIEW_ENABLED ?? "true") !== "false",
  // Same shape, same default. Purely informational (never blocks a push) — one more
  // read-only turn per successful task, same cost tier as review/memory.
  testingNotesEnabled: (process.env.TESTING_NOTES_ENABLED ?? "true") !== "false",
  maxIterations: Number(process.env.MAX_ITERATIONS ?? 5),
  maxBudgetUsd: Number(process.env.MAX_BUDGET_USD ?? 5),
  dailyBudgetUsd: Number(process.env.DAILY_BUDGET_USD ?? 20),
  maxTasksPerDay: Number(process.env.MAX_TASKS_PER_DAY ?? 10),
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
    allowedChatIds: (process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    idlePollSeconds: Number(process.env.IDLE_POLL_SECONDS ?? 300),
    activePollSeconds: Number(process.env.ACTIVE_POLL_SECONDS ?? 10),
  },
  dashboard: {
    port: Number(process.env.DASHBOARD_PORT ?? 4790),
  },
};

export type RepoKind = keyof typeof config.repos;
