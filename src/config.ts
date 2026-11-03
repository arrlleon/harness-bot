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
    },
    frontend: {
      path: process.env.FRONTEND_REPO_PATH ?? "",
      gates: buildGates("FRONTEND", "yarn test"),
      gitlabProjectPath: process.env.FRONTEND_GITLAB_PROJECT ?? "saqr/front-ai",
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
  },
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
