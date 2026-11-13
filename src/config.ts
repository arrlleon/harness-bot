import "dotenv/config";
import type { GateSpec } from "./types.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

// A typo in a numeric setting used to become NaN and silently switch the thing off:
// `spent >= NaN` is always false, so a mistyped DAILY_BUDGET_USD removed the daily cap
// without a word. Fail at startup instead.
export function numberEnv(name: string, fallback: number, source: NodeJS.ProcessEnv = process.env): number {
  const raw = source[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Env var ${name} must be a non-negative number, got ${JSON.stringify(raw)}`);
  }
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
  // `${prefix}_TEST_STRICT` opts into a diff-scoped test command (see e.g.
  // scripts/scoped-test.mjs, wired via BACKEND_VERIFY_CMD) ignoring its
  // baseline — XEN-541 (2026-11-10): back-ai's full 1211-file `yarn test` took 45+
  // minutes, on every iteration. A diff-scoped run's baseline is always vacuously
  // empty (nothing's changed yet at baseline time), so there's no real "N pre-existing
  // failures to tolerate" to compare against — same reasoning as the acceptance-test
  // gate, which is strict for the same reason. Off by default: only meaningful paired
  // with a command that's actually diff-scoped, not the plain full-suite default.
  gates.push({
    name: "test",
    command: process.env[`${prefix}_VERIFY_CMD`] ?? defaultTestCommand,
    strict: process.env[`${prefix}_TEST_STRICT`] === "true",
  });
  const build = process.env[`${prefix}_GATE_BUILD`];
  if (build) gates.push({ name: "build", command: build });
  // A diff-only check that a schema change ships with a migration (scripts/schema-
  // migration-check.mjs). Strict for the same reason as a diff-scoped test: before the
  // first edit there is nothing to compare, and "no worse than baseline" has no meaning.
  const migrations = process.env[`${prefix}_GATE_MIGRATIONS`];
  if (migrations) gates.push({ name: "migrations", command: migrations, strict: true });
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
      // Reproduced live (XEN-539): a React-component acceptance test needs real JSX
      // (`render(<Modal .../>)`), and tsc only parses JSX in a .tsx file — a `.test.ts`
      // acceptance test with JSX in it fails tsc with a cascade of unrelated-looking
      // syntax errors ("'>' expected", "Unterminated regular expression literal"),
      // not a clear "wrong extension" message. vitest's own `include` picks up both
      // .test.ts and .test.tsx (see .env.example), so this was silently wrong for
      // every frontend task whose acceptance test needs to render a component.
      acceptanceTestExt: process.env.FRONTEND_ACCEPTANCE_TEST_EXT ?? "test.tsx",
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
    // The free-text chat (bot/assistant.ts): answers questions about what happened and
    // about the code (read-only access to both repos) and picks bot commands. Needs
    // real reading comprehension, unlike the old keyword classifier — propose's tier.
    assistant: process.env.ASSISTANT_MODEL ?? process.env.PROPOSE_MODEL ?? "claude-sonnet-5",
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
    // capability, not just a bounded turn to save cost — same tier as implement, but
    // deliberately a different model lineage (not just a smaller Opus), the same way
    // ETS Tender's own review intentionally doesn't share a model with its developer
    // role: a reviewer built the same way as the implementer is more likely to share
    // its blind spots, not just its strengths.
    review: process.env.REVIEW_MODEL ?? "claude-fable-5-1",
    // Writing a tester's walkthrough from a diff + task description is the same
    // bounded-judgment shape as propose/acceptance/memory, not an open-ended loop —
    // Sonnet, same tier as those.
    testing: process.env.TESTING_MODEL ?? "claude-sonnet-5",
    // Same bounded-judgment shape again — translating a diff into a few plain-language
    // sentences for a non-technical audience needs real judgment about what matters,
    // not raw capability — Sonnet, same tier as testing/memory/acceptance/propose.
    report: process.env.REPORT_MODEL ?? "claude-sonnet-5",
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
  // Caps the reviewer<->developer negotiation (blocking finding -> dev fixes it in the
  // same session -> gates re-run -> reviewer looks again). Two agents that disagree
  // need a hard stop the same way MAX_ITERATIONS is one for the gate-fixing loop —
  // otherwise a pair that never agrees just burns the whole task budget arguing.
  maxReviewRounds: numberEnv("MAX_REVIEW_ROUNDS", 3),
  // Same shape, same default. Costs nothing extra (a brief is a different shape of the
  // SAME implement turn's response, not a separate turn) — the toggle exists for
  // debugging/rollback, same reasoning as gateIntegrityCheckEnabled.
  briefsEnabled: (process.env.BRIEFS_ENABLED ?? "true") !== "false",
  // After the plan is approved, take the task to an MR without asking (autopilot.ts):
  // answer the agent's own questions with its recommended option, and retry a stop
  // through "Решить самому" up to maxFixes times, within taskCapUsd for the whole task.
  // Ceiling for one chat answer; a question that needs a look at the code costs cents.
  assistantMaxBudgetUsd: numberEnv("ASSISTANT_MAX_BUDGET_USD", 1.5),
  autopilot: {
    enabled: (process.env.AUTOPILOT ?? "true") !== "false",
    maxFixes: numberEnv("AUTOPILOT_MAX_FIXES", 2),
    taskCapUsd: numberEnv("AUTOPILOT_TASK_CAP_USD", 80),
  },
  // Same shape, same default. Purely informational (never blocks a push) — one more
  // read-only turn per successful task, same cost tier as review/memory.
  testingNotesEnabled: (process.env.TESTING_NOTES_ENABLED ?? "true") !== "false",
  // Same shape, same default. Replaces the bare "closed, here's the MR" Telegram
  // message with a few plain-language sentences for whoever asked for the ticket —
  // one more read-only turn per successful task, same cost tier as testing notes.
  closeReportEnabled: (process.env.CLOSE_REPORT_ENABLED ?? "true") !== "false",
  // Same shape, same default. No extra LLM turn — composes the closeReport/testingNotes
  // text already generated for this task into one file, attached to the Jira issue the
  // moment it leaves "in progress", so a tester opens the ticket to a document instead
  // of having to read the comment thread.
  workReportEnabled: (process.env.WORK_REPORT_ENABLED ?? "true") !== "false",
  // Same opt-out shape, but this one is pure diff parsing — no extra LLM turn, no extra
  // cost or latency — so there's little reason to turn it off outside of debugging it.
  gateIntegrityCheckEnabled: (process.env.GATE_INTEGRITY_CHECK_ENABLED ?? "true") !== "false",
  // Same opt-out shape. One extra `git fetch` per new task (no LLM turn) — fetches
  // GITLAB_TARGET_BRANCH and branches the new worktree from there instead of repoPath's
  // possibly-stale local HEAD, so gates/acceptance tests run against what the MR will
  // actually be merged into, not whatever a human last happened to have checked out.
  freshBaseEnabled: (process.env.FRESH_BASE_ENABLED ?? "true") !== "false",
  // Same opt-out shape. Reproduced live (XEN-541): tagged [frontend], but the propose
  // turn found the real fix was entirely backend-side — without this, that's either a
  // needs_human escalation or a proposal whose only "acceptance criteria" are "tell the
  // backend team", neither of which actually closes anything. Lets queue.ts retag the
  // ticket and re-propose against the other repo instead of treating a simple tagging
  // mistake as a stopper. Off reverts to the old behavior: the propose turn is never
  // told it can redirect, and would just write whatever plan it can for the repo it
  // was handed.
  repoRetagEnabled: (process.env.REPO_RETAG_ENABLED ?? "true") !== "false",
  maxIterations: numberEnv("MAX_ITERATIONS", 5),
  maxBudgetUsd: numberEnv("MAX_BUDGET_USD", 5),
  // A resumed session's answer quality degrades well before this many tokens would
  // ever hit a real context-window limit — this is a quality safety net, not a window
  // ceiling. 150k matches Avengers Harness's own starting value for the same check
  // (same reasoning: min(40% of window, 150k), picked conservative over precise).
  maxContextTokens: numberEnv("CONTEXT_BUDGET_TOKENS", 150_000),
  dailyBudgetUsd: numberEnv("DAILY_BUDGET_USD", 20),
  maxTasksPerDay: numberEnv("MAX_TASKS_PER_DAY", 10),
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
    allowedChatIds: (process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    idlePollSeconds: numberEnv("IDLE_POLL_SECONDS", 300),
    activePollSeconds: numberEnv("ACTIVE_POLL_SECONDS", 10),
  },
  dashboard: {
    port: numberEnv("DASHBOARD_PORT", 4790),
    // Loopback by default: the dashboard has no auth and its /start endpoint spends
    // money. It used to listen on every interface, i.e. to anyone on the same network.
    host: process.env.DASHBOARD_HOST ?? "127.0.0.1",
  },
};

export type RepoKind = keyof typeof config.repos;

// Name -> live value for exactly the secrets in SECRET_ENV_VARS, read from the same
// `config` object every other consumer uses rather than process.env again — used to
// scrub a role's returned text (claudeEngine.ts's runClaudeTurn) before it's ever
// written to a memory file, Jira comment, or MR description. See secretScrub.ts.
export function secretValues(): Record<string, string> {
  return {
    JIRA_PAT: config.jira.token,
    GITLAB_TOKEN: config.gitlab.token,
    TELEGRAM_BOT_TOKEN: config.telegram.botToken,
  };
}
