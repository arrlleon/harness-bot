# jira-harness

Pulls tasks from Jira and runs the full close-out pipeline (implement → verify →
iterate) until the task meets its acceptance criteria, driven from a Telegram
bot with a live web dashboard. Target autonomy boundary: up to opening the
MR and setting Jira status to "on review" — never auto-merge, never close the
ticket itself.

## Build plan

0. Credentials/infra
1. **Core single-task close loop (done)** — prove execution + verification
   works for one task, no Jira/Telegram yet
2. **Jira queue (done)** — pull one assigned To Do ticket, route it to
   back-ai/front-ai by a `[backend]`/`[frontend]` prefix, run it through the
   Step 1 loop, push + open a GitLab MR, move the ticket to review
3. **Telegram bot (done)** — `/start`/`/stop`/`/status`, drives the queue on
   a poll loop, reports cost per task
4. Token/cost tracking persisted across tasks — folded into step 3
   (`.harness-state/bot-state.json`)
5. **Live web dashboard (done)** — `/dashboard` in Telegram, local-only
6. **Guardrails (done)** — daily budget/task caps, mechanical deny-list for
   migrations/CI/secrets/lockfiles

## Step 1 design, and why it looks like this

The engine drives the `claude` CLI headlessly (`-p --output-format json`),
not the SDK and not `--bg`. Three things learned by testing against the real
CLI, not assumed:

- **ECC must be disabled globally** (`claude plugin disable ecc`). Installed
  at user scope, its hooks match on tool name only (`Write`, `Edit`, `Bash`,
  `.*`) with no project scoping, so they fire on every session anywhere,
  including this harness's headless runs. One of them is interactive
  (presents facts, waits on an answer) — with nobody attached to a
  background session, it hangs forever. `--bare` looked like the fix but
  can't be used instead: it only accepts `ANTHROPIC_API_KEY`, never the
  subscription/OAuth login this account uses.
- **The agent never runs Bash.** Even `--permission-mode bypassPermissions`
  doesn't get unattended shell execution in a headless `-p` run — Claude
  Code's Auto Mode classifier sits in front of the permission system and
  blocks it independently (confirmed live: a trivial `echo` was denied with
  "Blocked by classifier"). Rather than fight that layer, the agent gets
  `--disallowedTools Bash` and only ever edits files; git (commit, and later
  push/MR) is done by the harness's own trusted code, never the model. This
  also matches DEVBOT's ADR-1 instinct (infra actions stay out of the
  model's hands) even though the execution venue here is local, not CI.
- **Each task runs in its own `git worktree`**, not a branch checked out in
  the shared working copy. Needed for safe parallelism later (Step 2+ will
  run multiple tasks at once) and keeps a stuck/misbehaving task from
  touching the main checkout.

Verification is an externally-supplied shell command (e.g. `pnpm test`) run
directly by the harness via `child_process`, never by the agent — so a
"passing" result can't be the model's own unverified claim.

## Usage

### Step 1: one-off task against any repo

```bash
npm run build
node dist/cli.js run \
  --repo /path/to/target/repo \
  --task '{"id":"XEN-1","title":"...","description":"...","acceptanceCriteria":["..."]}' \
  --verify "pnpm test" \
  --max-iterations 5 \
  --max-budget-usd 5
```

`--task` also accepts a path to a `.json` file with the same shape, or a bare
string (treated as an ad-hoc task description with no id/criteria). Output
ends with the worktree path and branch name holding the committed fix;
nothing is pushed.

### Step 2: Jira queue

```bash
cp .env.example .env   # fill in JIRA_PAT and GITLAB_TOKEN, check status names
npm run build
node dist/cli.js queue
```

Each run picks the single highest-priority ticket assigned to you in "To Do",
moves it to "In Progress", runs the Step 1 loop against whichever repo its
`[backend]`/`[frontend]` prefix points at, and on success pushes the branch
and opens a GitLab MR before moving the ticket to the review status. A ticket
is left "In Progress" with an explanatory comment (not silently retried) if:
routing is ambiguous (no prefix), the loop didn't verify, or the push/MR step
failed — those need a human to look, not another automatic attempt.

Run `queue` on a timer (cron, `watch`, or the Telegram bot in Step 3) to
actually drain the queue; one invocation does exactly one ticket.

### Step 3: Telegram bot

```bash
# in .env: TELEGRAM_BOT_TOKEN (from @BotFather), TELEGRAM_ALLOWED_CHAT_IDS
# (your numeric chat id, from @userinfobot — comma-separated for more than one)
npm run build
node dist/cli.js bot
```

`TELEGRAM_ALLOWED_CHAT_IDS` is a hard allowlist, not a convenience default —
the bot can push code and open MRs, so it silently drops commands from any
chat not on the list rather than exposing that to whoever finds the bot.

- `/start` — lists every ticket assigned to you in To Do *and* In Progress
  (so a ticket already picked up by hand, or left mid-flow, stays visible),
  one inline button per ticket. **It does not pick anything on its own.**
  Tapping a button runs a read-only turn against just that ticket
  (Edit/Write/Bash all denied — verified live: zero file changes, just a
  short plan) and sends a Telegram message with the ticket's description,
  the proposed solution, and inline **✅ Подтвердить / ❌ Отменить** buttons.
  The actual close-loop (same pipeline as everywhere else — worktree, verify,
  push, MR, review) only starts after you tap Подтвердить. Отменить records
  the (small) analysis cost against the budget and skips that ticket for the
  rest of the process's life, so it isn't immediately re-proposed. Only one
  proposal is pending at a time; picking another ticket while one is pending
  is refused until it's resolved.
- `/status` — running state, all-time and today's cost, last ticket handled.
- `/stop` — deactivates buttons on tickets already listed by `/start`
  (call `/start` again for a fresh list); lets whatever's in flight finish
  rather than killing it mid-task.
- `/kill` — SIGTERMs the in-flight `claude` turn right now, for when it's
  stuck or doing something you don't want to wait out. The interrupted task
  surfaces as a queue error, not a silent disappearance.
- `/budget` — today's spend and task count against `DAILY_BUDGET_USD` /
  `MAX_TASKS_PER_DAY`, and the per-task caps.
- `/peek` — shows the ticket that would be picked up next (key, summary,
  which repo it routes to, first 1000 chars of its description) without
  transitioning it or spending anything.
- `/retry XEN-123` — moves a ticket stuck "needs a human" back into the
  queue's pickup status, for after you've fixed whatever blocked it (e.g.
  added the missing `[backend]`/`[web]` prefix).
- `/help` — lists all of the above.

State (history, running flag) persists to `.harness-state/bot-state.json`
across bot restarts.

### Step 5: live dashboard

`/dashboard` in Telegram replies with an "Open dashboard" button linking to
`http://localhost:4790` (`DASHBOARD_PORT`). The server starts automatically
with the bot (`node dist/cli.js bot`), or standalone for testing with
`node dist/cli.js dashboard`.

It shows the one job currently in flight — queue processes tickets one at a
time, so this is a single progress card, not a multi-agent grid: issue key,
title, repo, phase (transitioning/iterating/verifying/pushing/opening_mr/
commenting), iteration N/max, cost so far, elapsed time, the ticket's own
description (collapsed), a scrolling live log of what the agent is actually
doing (`Edit <file>`, `Grep "<pattern>"`, its own narration — streamed as it
happens via `--output-format stream-json`, not polled after the fact) — plus
the last 20 completed tasks (outcome, MR link or reason, cost, timestamp). It
polls `/api/state` every 2s; no auth, since it only binds to localhost.

**Ticket list + manual dispatch.** A "next up" panel lists whatever's
currently assigned to you in the queue's pickup status (same ticket pool
`/peek` and the bot's auto-pick draw from), each with its description and
detected repo, refreshed every 15s (`GET /api/tickets`, cached that long —
it's a real Jira search, not free to poll every 2s). Clicking **Start** on
one (`POST /api/tickets/:key/start`) dispatches that specific ticket through
the same close-loop/push/MR/review-transition pipeline as the auto-picked
path — it's "run this one now" layered on top of the queue, not a separate
mechanism: same budget caps, same routing rules, same guardrails. A ticket
whose prefix doesn't route anywhere is listed but its Start button is
disabled. Only one job runs at a time; clicking Start while something's
already in flight is rejected with 409 before touching Jira.

**The pixel-art scene** at the top is a parody of *The Last Supper* — nine
robed figures in a hall with arched windows and tapestries, seated behind a
long tablecloth-covered table (closer to the painting's composition than a
first simplified pass: individual hair/beard colors, varied robe/accent
colors, a visually distinct center figure). Idle (nothing in the queue): each
bobs its own cup up to its mouth on an independent rhythm — having lunch.
Working: a document tile travels hand-to-hand down the table in a loop, with
the two figures currently passing it drawn with arms extended toward each
other. Pure canvas `fillRect` pixel art (no image assets, no library),
redrawn every 90ms; the mode is driven by whether `live.currentJob` is set in
the same `/api/state` poll the rest of the page already uses. Verified by
screenshotting the actual rendered page with headless Chrome, not just
reading the code.

**UI**: entirely in Russian (dashboard and bot replies both), and organized
into tabs — Текущая задача / Очередь / История — with a one-line hint under
the tab bar explaining what each one shows, instead of one long stacked page.

This only works from the same machine the bot runs on — the link is
`localhost`, so Telegram Desktop there opens it in the default browser.
Reaching it from a phone would need a tunnel (ngrok/cloudflared), which isn't
wired up.

### Step 6: guardrails

Two independent layers, checked at different points:

- **Daily caps** (`DAILY_BUDGET_USD`, `MAX_TASKS_PER_DAY`) — `runQueueOnce`
  checks today's spend/task count against these *before* touching Jira at
  all, so a cap never leaves a ticket stranded "In Progress" mid-transition.
  Once hit, the queue returns `paused` and the bot reports it once (not every
  idle poll) until the reason changes.
- **Path deny-list** (`src/engine/guardrails.ts`) — migrations, `.env*`,
  CI config, lockfiles, and key/pem files are mechanically unreachable by the
  agent via Claude Code's own `--disallowedTools Edit(<glob>),Write(<glob>)`,
  verified live: a denied path is refused at the tool-call level (the agent's
  own turn reports it couldn't touch the file), not just discouraged by the
  prompt. Applies to every `run`/`queue` invocation automatically; there's no
  escape hatch to turn it off per-task.

Per-task caps (`MAX_ITERATIONS`, `MAX_BUDGET_USD`) and the `[backend]`/
`[frontend]`/`[web]`-ambiguity skip from Step 2 are the other two guardrails
already in place from earlier steps.

### Step 7: tests, and a mechanical gate that enforces them

`npm test` runs the suite via Node's built-in test runner (`node:test`,
Node 20+) loaded through `tsx` — no extra test-framework dependency. Covers
`detectRepo`/`toTaskSpec` routing, prompt formatting, the gate
baseline-comparison logic from Step 6's verify engine, real temp-git-repo
integration tests for worktree creation/commit/diff, and checkpoint
write/recover.

New features are expected to ship with tests in the same change — enforced
mechanically, not left to memory, via two git hooks in `.githooks/`:

- **`pre-commit`**: runs the full suite; a failing test blocks the commit
  outright.
- **`commit-msg`**: blocks a commit that touches `src/**/*.ts` logic without
  also touching a `*.test.ts` file — unless the commit message has an
  explicit `No-Test: <reason>` line (for commits that genuinely don't need
  one: docs, config, pure wiring). This is the intended way to skip the
  check for a specific commit — not `git commit --no-verify`, which would
  also skip the test-suite check above.

These aren't enabled by default on a fresh clone (`.git/hooks` isn't
version-controlled) — point git at the tracked directory once:

```
git config core.hooksPath .githooks
```
