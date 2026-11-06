import { config } from "./config.js";
import { JiraClient, type JiraIssue } from "./jira/client.js";
import { detectRepo, toTaskSpec, type RepoDetection } from "./jira/mapToTask.js";
import { runCloseLoop } from "./engine/loop.js";
import { buildBriefAnswerPrompt } from "./engine/brief.js";
import { runClaudeTurn } from "./engine/claudeEngine.js";
import { parseProposalResponse } from "./engine/proposal.js";
import { readMemoryFiles, buildMemoryContextBlock } from "./engine/memory.js";
import { createMergeRequest, pushBranch } from "./gitlab.js";
import {
  startJob,
  updateJob,
  finishJob,
  appendLog,
  getLiveState,
  setPendingApproval,
  clearPendingApproval,
  setPendingHumanReview,
  clearPendingHumanReview,
  setPendingBrief,
  clearPendingBrief,
} from "./bot/liveState.js";
import { commitAll, deleteBranch, getWorktreeDiff, removeWorktree, worktreeDirFor } from "./engine/git.js";
import { writeCheckpoint, clearCheckpoint } from "./engine/checkpoint.js";
import { loadState, costSince, countSince, startOfTodayIso, estimateCost, type CostEstimate } from "./bot/state.js";
import type { CloseLoopResult, EngineConfig, GateSpec, QueueRunOutcome, TaskSpec } from "./types.js";

// What runJob itself can determine — it has no notion of elapsed wall-clock time or
// which repo was targeted (that's dispatchIssue's job, wrapping the call). Same shape
// as QueueRunOutcome's needs_human/closed variants minus durationMs/repo; dispatchIssue
// adds those once, after runJob returns, rather than threading them through every one
// of runJob's own return statements.
type JobOutcome =
  | { kind: "busy"; issueKey: string }
  | { kind: "skipped"; issueKey: string; reason: string }
  | { kind: "needs_human"; issueKey: string; costUsd: number; reason: string; worktreeDir: string; branchName: string; reviewRounds?: number }
  | { kind: "closed"; issueKey: string; costUsd: number; mrUrl: string; reviewRounds?: number }
  | { kind: "brief_pending"; issueKey: string };

const QUEUE_JQL = () =>
  `project = ${config.jira.projectKey} AND assignee = currentUser() AND statusCategory = "To Do" ORDER BY priority DESC`;

// /start's ticket menu: also includes what's already In Progress (picked up earlier by
// hand, or by this harness) so a resumed proposal doesn't disappear from view.
const MENU_JQL = () =>
  `project = ${config.jira.projectKey} AND assignee = currentUser() AND statusCategory in ("To Do", "In Progress") ORDER BY priority DESC`;

export interface Candidate {
  issue: JiraIssue;
  detection: RepoDetection;
}

export async function listCandidates(): Promise<Candidate[]> {
  const jira = new JiraClient(config.jira.baseUrl, config.jira.token);
  const issues = await jira.searchIssues(QUEUE_JQL());
  return issues.map((issue) => ({ issue, detection: detectRepo(issue) }));
}

export async function listMenuCandidates(): Promise<Candidate[]> {
  const jira = new JiraClient(config.jira.baseUrl, config.jira.token);
  const issues = await jira.searchIssues(MENU_JQL());
  // MENU_JQL's statusCategory filter is intentionally broad (literal-status JQL was
  // rejected by this Jira instance for a status that genuinely exists — see QUEUE_JQL's
  // own comment), but that means it also returns anything else sharing the "In Progress"
  // category — e.g. QA — which the harness has no business picking up. Narrow to exactly
  // the two literal statuses it actually understands.
  const menuStatuses = new Set([config.jira.todoStatus, config.jira.inProgressStatus]);
  const filtered = issues.filter((issue) => issue.status && menuStatuses.has(issue.status));
  return filtered.map((issue) => ({ issue, detection: detectRepo(issue) }));
}

export async function peekNext(): Promise<Candidate | null> {
  const candidates = await listCandidates();
  return candidates[0] ?? null;
}

export async function retryIssue(issueKey: string): Promise<void> {
  const jira = new JiraClient(config.jira.baseUrl, config.jira.token);
  await jira.transitionTo(issueKey, config.jira.todoStatus);
}

export interface Proposal {
  issueKey: string;
  title: string;
  repo: string;
  descriptionShort: string;
  plan: string;
  acceptanceCriteria: string[];
  costUsd: number;
  costEstimate: CostEstimate | null;
}

export type ProposeOutcome =
  | { kind: "empty" }
  | { kind: "paused"; reason: string }
  | { kind: "awaiting_approval" }
  | { kind: "busy" }
  | { kind: "skipped"; issueKey: string; reason: string }
  | { kind: "proposed"; proposal: Proposal };

// Declined tickets are skipped for the rest of this process's life so a
// cancelled proposal doesn't just get re-sent next poll — reset on restart,
// same as the rest of the in-memory live state.
const declinedKeys = new Set<string>();

// Read-only: explores the repo but is denied Edit/Write/MultiEdit outright
// (not just the usual sensitive-path subset) so a "preview" can never itself
// change anything before the human has approved doing so.
//
// The acceptance criteria produced here are a contract, not a suggestion: once the
// human approves this proposal they're frozen into PendingApproval/TaskSpec and never
// regenerated — implement only ever reads them for prompt context, it has no path to
// change them (TaskSpec is never mutated after dispatch). Reduces scope drift the same
// way Avengers Harness's frozen-acceptance-tests idea does, just without a separate
// executable-test layer.
async function proposeSolution(task: TaskSpec, repoPath: string): Promise<{ plan: string; acceptanceCriteria: string[]; costUsd: number }> {
  const memoryContext = buildMemoryContextBlock(await readMemoryFiles(repoPath, "pm"), "pm");
  const prompt = [
    `Задача ${task.id}: ${task.title}`,
    "",
    task.description,
    memoryContext ? `\n${memoryContext}\n` : "",
    "Не редактируй и не создавай файлы — только изучи код (Read/Grep/Glob).",
    "Ответь строго в этом формате, на русском:",
    "",
    "ПЛАН:",
    "<2-4 коротких предложения: в чём проблема и что именно ты планируешь изменить>",
    "",
    "КРИТЕРИИ ПРИЁМКИ:",
    "- <конкретный, проверяемый критерий>",
    "- <ещё один>",
    "(3-7 критериев — что именно должно стать верным, чтобы задача считалась решённой;",
    "формулируй так, чтобы по каждому можно было однозначно сказать да или нет)",
  ].join("\n");
  const turn = await runClaudeTurn({
    cwd: repoPath,
    prompt,
    permissionMode: "acceptEdits",
    disallowedToolsOverride: "Bash,Edit,Write,MultiEdit",
    model: config.models.propose,
  });
  const { plan, acceptanceCriteria } = parseProposalResponse(turn.resultText);
  return { plan, acceptanceCriteria, costUsd: turn.totalCostUsd };
}

// Cross-repo tickets (tagged [backend]+[frontend]/[web]) get one proposeSolution turn
// per repo instead of one combined turn — each only ever reads its own codebase, so
// its own plan/criteria naturally come out scoped to what it can actually see, with no
// need for the model to guess at a shared vocabulary across two unrelated repos. The
// two plans/criteria lists are tagged with a "[backend]"/"[frontend]" prefix purely so
// they can travel through the existing flat Proposal.plan/acceptanceCriteria fields
// (shown to the human, then frozen verbatim on approval) and be split back apart by
// splitCrossRepoCriteria() at dispatch time — avoids a parallel set of cross-repo-only
// types for PendingApproval/Proposal.
async function proposeCrossRepoSolution(
  task: TaskSpec,
): Promise<{ plan: string; acceptanceCriteria: string[]; costUsd: number }> {
  const [backend, frontend] = await Promise.all([
    proposeSolution(task, config.repos.backend.path),
    proposeSolution(task, config.repos.frontend.path),
  ]);
  return {
    plan: `[backend]\n${backend.plan}\n\n[frontend]\n${frontend.plan}`,
    acceptanceCriteria: [
      ...backend.acceptanceCriteria.map((c) => `[backend] ${c}`),
      ...frontend.acceptanceCriteria.map((c) => `[frontend] ${c}`),
    ],
    costUsd: backend.costUsd + frontend.costUsd,
  };
}

// Reverses the tagging proposeCrossRepoSolution applied — an untagged criterion (should
// never happen coming out of that function, but a human can in principle hand-edit
// nothing here since approval is a single yes/no, not a text edit) is dropped rather
// than guessed into either side.
export function splitCrossRepoCriteria(criteria: string[]): { backend: string[]; frontend: string[] } {
  const backend: string[] = [];
  const frontend: string[] = [];
  for (const c of criteria) {
    if (c.startsWith("[backend] ")) backend.push(c.slice("[backend] ".length));
    else if (c.startsWith("[frontend] ")) frontend.push(c.slice("[frontend] ".length));
  }
  return { backend, frontend };
}

// Shared by proposeNext (auto-picked, whatever's top of the JQL order) and
// proposeIssueByKey (manually picked from /start's ticket menu).
async function proposeIssue(
  jira: JiraClient,
  issue: JiraIssue,
  onAnalyzing?: (issueKey: string) => void | Promise<void>,
): Promise<ProposeOutcome> {
  const detection = detectRepo(issue);
  if (detection.kind === "unknown") {
    const reason = "no [backend]/[frontend]/[web] prefix in title or description";
    declinedKeys.add(issue.key); // can't route it regardless of approval; no point re-surfacing
    await jira.addComment(
      issue.key,
      `jira-harness: could not determine a single target repository (${reason}). Skipped — left in To Do.`,
    );
    return { kind: "skipped", issueKey: issue.key, reason };
  }

  if (detection.kind === "ambiguous") {
    if (!config.repos.backend.path || !config.repos.frontend.path) {
      const reason = "cross-repo ticket but BACKEND_REPO_PATH/FRONTEND_REPO_PATH aren't both configured";
      declinedKeys.add(issue.key);
      await jira.addComment(issue.key, `jira-harness: ${reason}. Skipped — left in To Do.`);
      return { kind: "skipped", issueKey: issue.key, reason };
    }

    await onAnalyzing?.(issue.key);

    const task = toTaskSpec(issue);
    const { plan, acceptanceCriteria, costUsd } = await proposeCrossRepoSolution(task);
    const costEstimate = estimateCost(loadState(), "cross");

    setPendingApproval({
      issueKey: issue.key,
      title: issue.summary,
      repo: "cross",
      description: issue.description,
      descriptionShort: issue.description.slice(0, 300),
      plan,
      acceptanceCriteria,
      costUsd,
      costEstimate,
    });

    return {
      kind: "proposed",
      proposal: {
        issueKey: issue.key,
        title: issue.summary,
        repo: "cross",
        descriptionShort: issue.description.slice(0, 300),
        plan,
        acceptanceCriteria,
        costUsd,
        costEstimate,
      },
    };
  }

  const repo = config.repos[detection.kind];
  if (!repo.path) {
    throw new Error(`Repo path for "${detection.kind}" is not configured (set ${detection.kind.toUpperCase()}_REPO_PATH)`);
  }

  // The analysis turn below can take a while against a real codebase — tell
  // whoever's watching before going quiet, not after (reproduced live: a
  // multi-minute silent gap reads as "it's stuck", not "it's thinking").
  await onAnalyzing?.(issue.key);

  const task = toTaskSpec(issue);
  const { plan, acceptanceCriteria, costUsd } = await proposeSolution(task, repo.path);
  const costEstimate = estimateCost(loadState(), detection.kind);

  setPendingApproval({
    issueKey: issue.key,
    title: issue.summary,
    repo: detection.kind,
    description: issue.description,
    descriptionShort: issue.description.slice(0, 300),
    plan,
    acceptanceCriteria,
    costUsd,
    costEstimate,
  });

  return {
    kind: "proposed",
    proposal: {
      issueKey: issue.key,
      title: issue.summary,
      repo: detection.kind,
      descriptionShort: issue.description.slice(0, 300),
      plan,
      acceptanceCriteria,
      costUsd,
      costEstimate,
    },
  };
}

export async function proposeNext(onAnalyzing?: (issueKey: string) => void | Promise<void>): Promise<ProposeOutcome> {
  const paused = checkDailyCaps();
  if (paused) return paused;
  if (getLiveState().pendingApproval) return { kind: "awaiting_approval" };
  if (getLiveState().currentJob) return { kind: "busy" };

  const jira = new JiraClient(config.jira.baseUrl, config.jira.token);
  const issues = await jira.searchIssues(QUEUE_JQL());
  const issue = issues.find((i) => !declinedKeys.has(i.key));
  if (!issue) return { kind: "empty" };

  return proposeIssue(jira, issue, onAnalyzing);
}

// Manually picked from /start's ticket menu — same guards as proposeNext, just
// skipping straight to a specific ticket instead of taking whatever's top of the JQL.
export async function proposeIssueByKey(
  issueKey: string,
  onAnalyzing?: (issueKey: string) => void | Promise<void>,
): Promise<ProposeOutcome> {
  const paused = checkDailyCaps();
  if (paused) return paused;
  if (getLiveState().pendingApproval) return { kind: "awaiting_approval" };
  if (getLiveState().currentJob) return { kind: "busy" };

  const jira = new JiraClient(config.jira.baseUrl, config.jira.token);
  const issue = await jira.getIssue(issueKey);
  return proposeIssue(jira, issue, onAnalyzing);
}

// Dispatches whatever's currently pending approval. Returns null if nothing
// was pending (e.g. a stale button click after a restart or a second click).
export async function confirmPending(): Promise<QueueRunOutcome | null> {
  const pending = getLiveState().pendingApproval;
  if (!pending) return null;
  clearPendingApproval();

  const jira = new JiraClient(config.jira.baseUrl, config.jira.token);
  const issue: JiraIssue = { key: pending.issueKey, summary: pending.title, description: pending.description };
  const outcome = await dispatchIssue(jira, issue, pending.acceptanceCriteria);
  // Fold the analysis turn's own cost into whatever gets recorded, so it
  // still counts against the daily budget instead of being invisible spend.
  if (outcome.kind === "closed" || outcome.kind === "needs_human") {
    return { ...outcome, costUsd: outcome.costUsd + pending.costUsd };
  }
  return outcome;
}

// Returns the cancelled proposal (so the caller can record its cost) or null
// if there was nothing pending.
export function cancelPending(): Proposal | null {
  const pending = getLiveState().pendingApproval;
  if (!pending) return null;
  clearPendingApproval();
  declinedKeys.add(pending.issueKey);
  return {
    issueKey: pending.issueKey,
    title: pending.title,
    repo: pending.repo,
    descriptionShort: pending.descriptionShort,
    plan: pending.plan,
    acceptanceCriteria: pending.acceptanceCriteria,
    costUsd: pending.costUsd,
    costEstimate: pending.costEstimate,
  };
}

function checkDailyCaps(): { kind: "paused"; reason: string } | null {
  const persisted = loadState();
  const todayIso = startOfTodayIso();
  const spentToday = costSince(persisted, todayIso);
  const tasksToday = countSince(persisted, todayIso);
  if (spentToday >= config.dailyBudgetUsd) {
    return { kind: "paused", reason: `daily budget reached ($${spentToday.toFixed(2)}/$${config.dailyBudgetUsd})` };
  }
  if (tasksToday >= config.maxTasksPerDay) {
    return { kind: "paused", reason: `daily task cap reached (${tasksToday}/${config.maxTasksPerDay})` };
  }
  return null;
}

// Shared by the auto-picked (runQueueOnce), manually-picked (runTicketByKey, from a
// dashboard click), and proposed-and-approved (confirmPending) paths — all route,
// budget-check, and dispatch the same way; they only differ in how the issue was
// selected and whether a human-approved contract already exists for it.
//
// acceptanceCriteria defaults to [] for the two paths that skip propose/approve
// entirely (no human has reviewed a contract for them) — confirmPending is the only
// caller that ever passes a non-empty list, and it's frozen at that point: nothing
// after this regenerates or edits it, the close loop only ever reads it for context.
async function dispatchIssue(jira: JiraClient, issue: JiraIssue, acceptanceCriteria: string[] = []): Promise<QueueRunOutcome> {
  if (getLiveState().currentJob) {
    return { kind: "busy", issueKey: issue.key };
  }

  const detection = detectRepo(issue);
  if (detection.kind === "unknown") {
    const reason = "no [backend]/[frontend]/[web] prefix in title or description";
    await jira.addComment(
      issue.key,
      `jira-harness: could not determine target repository (${reason}). Skipped — left in To Do.`,
    );
    return { kind: "skipped", issueKey: issue.key, reason };
  }
  if (detection.kind === "ambiguous") {
    const backendRepo = config.repos.backend;
    const frontendRepo = config.repos.frontend;
    if (!backendRepo.path || !frontendRepo.path) {
      const reason = "cross-repo ticket but BACKEND_REPO_PATH/FRONTEND_REPO_PATH aren't both configured";
      await jira.addComment(issue.key, `jira-harness: ${reason}. Left in To Do.`);
      return { kind: "skipped", issueKey: issue.key, reason };
    }

    const { backend: backendCriteria, frontend: frontendCriteria } = splitCrossRepoCriteria(acceptanceCriteria);
    const backendTask: TaskSpec = { ...toTaskSpec(issue), acceptanceCriteria: backendCriteria };
    const frontendTask: TaskSpec = { ...toTaskSpec(issue), acceptanceCriteria: frontendCriteria };
    const backendBranch = `harness/${issue.key.toLowerCase()}-backend`;
    const frontendBranch = `harness/${issue.key.toLowerCase()}-frontend`;

    startJob(issue.key, issue.summary, issue.description, "cross", config.maxIterations);
    const crossStartedAt = Date.now();
    try {
      const outcome = await runCrossRepoJob(
        jira,
        issue,
        { task: backendTask, repo: backendRepo, branchName: backendBranch },
        { task: frontendTask, repo: frontendRepo, branchName: frontendBranch },
      );
      if (outcome.kind === "closed" || outcome.kind === "needs_human") {
        return { ...outcome, durationMs: Date.now() - crossStartedAt, repo: "cross" };
      }
      return outcome;
    } finally {
      finishJob();
    }
  }

  const repo = config.repos[detection.kind];
  if (!repo.path) {
    throw new Error(`Repo path for "${detection.kind}" is not configured (set ${detection.kind.toUpperCase()}_REPO_PATH)`);
  }

  const task: TaskSpec = { ...toTaskSpec(issue), acceptanceCriteria };
  const branchName = `harness/${issue.key.toLowerCase()}`;

  startJob(issue.key, issue.summary, issue.description, detection.kind, config.maxIterations);
  const startedAt = Date.now();
  try {
    const outcome = await runJob(jira, issue, repo, task, branchName);
    // durationMs/repo are added here, not inside runJob — one place computes them for
    // every path that did real work (success or needs_human), instead of threading
    // Date.now()/detection.kind through each of runJob's own return statements.
    if (outcome.kind === "closed" || outcome.kind === "needs_human") {
      return { ...outcome, durationMs: Date.now() - startedAt, repo: detection.kind };
    }
    return outcome;
  } finally {
    finishJob();
  }
}

export async function runQueueOnce(): Promise<QueueRunOutcome> {
  // Checked before touching Jira at all: a cap that only kicked in after
  // transitioning a ticket would leave it stranded "In Progress" for no reason.
  const paused = checkDailyCaps();
  if (paused) return paused;

  const jira = new JiraClient(config.jira.baseUrl, config.jira.token);
  // statusCategory (not a literal status name) survives workflow renames/per-project
  // status schemes; `status = "<name>"` rejected a status that genuinely appears on
  // issues in this project, apparently stale/scheme-specific — statusCategory held up.
  const issues = await jira.searchIssues(QUEUE_JQL());
  if (issues.length === 0) return { kind: "empty" };

  return dispatchIssue(jira, issues[0]);
}

// Manual dispatch from a dashboard click: same budget/routing/concurrency rules
// as the auto-picked path, just skipping straight to a specific ticket instead
// of taking whatever's top of the JQL order.
export async function runTicketByKey(issueKey: string): Promise<QueueRunOutcome> {
  const paused = checkDailyCaps();
  if (paused) return paused;

  const jira = new JiraClient(config.jira.baseUrl, config.jira.token);
  const issue = await jira.getIssue(issueKey);
  return dispatchIssue(jira, issue);
}

type RepoHandle = { path: string; gates: GateSpec[]; gitlabProjectPath: string; acceptanceRunner: string; acceptanceTestExt: string };

type CloseAndPushFailureKind = "loop" | "no_token" | "push";

interface CloseLoopAndPushOutcome {
  closeLoopResult: CloseLoopResult;
  mrUrl?: string;
  failureReason?: string;
  failureKind?: CloseAndPushFailureKind;
  // Set when the agent raised a brief instead of guessing — distinct from failureKind:
  // nothing went wrong, a decision is needed before this task can continue. The caller
  // persists result.brief/result.resumeState (setPendingBrief) rather than treating
  // this like any other failure.
  briefPending?: boolean;
}

// The actual "do the work" step, shared by the single-repo (runJob) and cross-repo
// (runCrossRepoJob) dispatch paths. Deliberately does none of the Jira
// commenting/status-transition side effects — a single-repo task and a cross-repo
// task need different comments/transitions around this same core step (one comment
// immediately vs. one combined comment only once both halves are known), so folding
// them in here would just mean every caller immediately undoing half of them.
async function closeLoopAndPush(
  issue: { key: string; summary: string },
  repo: RepoHandle,
  task: TaskSpec,
  branchName: string,
  resumeFrom?: EngineConfig["resumeFrom"],
): Promise<CloseLoopAndPushOutcome> {
  // Checkpoint is bookkeeping, not a resume mechanism: if this process dies mid-task
  // (OOM-kill etc.), the worktree on disk already has whatever's there — the
  // checkpoint just means a restart can find it and hand it to a human instead of
  // leaving an untracked worktree rotting in /tmp forever. Deliberately stays alive
  // through the ENTIRE function, not just the iteration loop: clearing it the instant
  // runCloseLoop returned (the old behavior) left a real gap — a crash during push/MR/
  // Jira-transition had no checkpoint (already cleared) AND no pendingHumanReview
  // (not set yet), so that window had zero durable record of the task at all. The
  // caller clears it once a final outcome is durably recorded elsewhere (closed, or
  // a persisted pendingHumanReview) — see the clearCheckpoint calls in runJob/
  // runCrossRepoJob.
  const checkpointAt = (worktreeDir: string, iteration: number, costUsd: number, phase: string): void => {
    writeCheckpoint({
      issueKey: issue.key,
      title: issue.summary,
      branchName,
      worktreeDir,
      gitlabProjectPath: repo.gitlabProjectPath,
      iteration,
      maxIterations: config.maxIterations,
      costUsd,
      phase,
      savedAt: new Date().toISOString(),
    });
  };

  const result = await runCloseLoop(task, {
    repoPath: repo.path,
    branchName,
    gates: repo.gates,
    maxIterations: config.maxIterations,
    maxBudgetUsd: config.maxBudgetUsd,
    maxContextTokens: config.maxContextTokens,
    permissionMode: "acceptEdits",
    model: config.models.implement,
    acceptanceTest: config.acceptanceTestsEnabled
      ? { model: config.models.acceptance, runner: repo.acceptanceRunner, ext: repo.acceptanceTestExt }
      : undefined,
    memory: config.memoryEnabled ? { model: config.models.memory, baseBranch: config.gitlab.targetBranch } : undefined,
    review: config.reviewEnabled
      ? { model: config.models.review, baseBranch: config.gitlab.targetBranch, maxRounds: config.maxReviewRounds }
      : undefined,
    testingNotes: config.testingNotesEnabled
      ? { model: config.models.testing, baseBranch: config.gitlab.targetBranch }
      : undefined,
    gateIntegrityCheck: config.gateIntegrityCheckEnabled ? { baseBranch: config.gitlab.targetBranch } : undefined,
    freshBase: config.freshBaseEnabled ? { baseBranch: config.gitlab.targetBranch } : undefined,
    briefsEnabled: config.briefsEnabled,
    resumeFrom,
    onIteration: ({ iteration, phase, costUsd, summary }) => {
      updateJob({ iteration, phase, costUsd, lastTurnSummary: summary });
      checkpointAt(worktreeDirFor(branchName), iteration, costUsd, phase);
    },
    onLog: appendLog,
  });

  if (result.stopReason === "brief_pending") {
    return { closeLoopResult: result, briefPending: true };
  }

  if (!result.success) {
    // "stuck", "review_blocked" and "gate_integrity_violation" all have more to say
    // than the bare stopReason word — naming the repeated gate(s), the actual blocking
    // finding(s), or the specific tampering caught up front saves a human from
    // re-deriving that from raw gate output or re-running the review turn.
    let reason: string = result.stopReason;
    if (result.stopReason === "stuck" && result.stuckGates?.length) {
      reason = `stuck (same failure repeated in: ${result.stuckGates.join(", ")})`;
    } else if (result.stopReason === "review_blocked" && result.reviewFindings?.length) {
      const blocking = result.reviewFindings.filter((f) => f.blocking);
      const rounds = result.reviewRounds ? ` после ${result.reviewRounds} раунд(ов) с разработчиком` : "";
      reason = `review_blocked${rounds}: ${blocking.map((f) => f.description).join("; ")}`;
    } else if (result.stopReason === "gate_integrity_violation" && result.gateIntegrityViolations?.length) {
      reason = `gate_integrity_violation: ${result.gateIntegrityViolations.join("; ")}`;
    } else if (result.stopReason === "context_budget" && result.contextTokens) {
      reason = `context_budget: session reached ~${Math.round(result.contextTokens / 1000)}k tokens, stopped before quality degrades further`;
    }
    return { closeLoopResult: result, failureReason: reason, failureKind: "loop" };
  }

  if (!config.gitlab.token) {
    return { closeLoopResult: result, failureReason: "no GITLAB_TOKEN configured", failureKind: "no_token" };
  }

  try {
    updateJob({ phase: "pushing" });
    checkpointAt(result.worktreeDir, result.iterations.length, result.totalCostUsd, "pushing");
    await pushBranch(result.worktreeDir, branchName);
    updateJob({ phase: "opening_mr" });
    checkpointAt(result.worktreeDir, result.iterations.length, result.totalCostUsd, "opening_mr");
    // Nonblocking findings didn't stop the push (that's the point — they're "worth
    // knowing", not "wrong"), but they shouldn't be silently discarded either; a human
    // reviewing the MR as usual sees them without needing the review turn re-run.
    const reviewNote = result.reviewFindings?.length
      ? `\n\nReview notes (nonblocking):\n${result.reviewFindings.map((f) => `- ${f.description}`).join("\n")}`
      : "";
    const mr = await createMergeRequest({
      gitlabBaseUrl: config.gitlab.baseUrl,
      token: config.gitlab.token,
      projectPath: repo.gitlabProjectPath,
      sourceBranch: branchName,
      targetBranch: config.gitlab.targetBranch,
      title: `${issue.key}: ${issue.summary}`,
      description: `Automated by jira-harness for ${issue.key}.\n\ncost: $${result.totalCostUsd.toFixed(4)}, iterations: ${result.iterations.length}${reviewNote}`,
    });
    return { closeLoopResult: result, mrUrl: mr.webUrl };
  } catch (err) {
    return { closeLoopResult: result, failureReason: `push/MR failed: ${(err as Error).message}`, failureKind: "push" };
  }
}

async function runJob(
  jira: JiraClient,
  issue: { key: string; summary: string },
  repo: RepoHandle,
  task: TaskSpec,
  branchName: string,
): Promise<JobOutcome> {
  updateJob({ phase: "transitioning" });
  await jira.transitionTo(issue.key, config.jira.inProgressStatus);

  const outcome = await closeLoopAndPush(issue, repo, task, branchName);
  return handleCloseLoopOutcome(jira, issue, repo, task, branchName, outcome);
}

// Shared by runJob's first attempt and resolveBrief's resumed attempt — a resumed
// session can succeed, fail, or raise ANOTHER brief, and all three need exactly the
// same handling a first attempt would get.
async function handleCloseLoopOutcome(
  jira: JiraClient,
  issue: { key: string; summary: string },
  repo: RepoHandle,
  task: TaskSpec,
  branchName: string,
  outcome: CloseLoopAndPushOutcome,
): Promise<JobOutcome> {
  const result = outcome.closeLoopResult;

  if (outcome.briefPending) {
    await jira.addComment(
      issue.key,
      `jira-harness: вопрос перед продолжением работы — см. Telegram.\n«${result.brief!.question}»`,
    );
    setPendingBrief({
      issueKey: issue.key,
      title: issue.summary,
      task,
      brief: result.brief!,
      worktreeDir: result.worktreeDir,
      branchName,
      gitlabProjectPath: repo.gitlabProjectPath,
      resumeState: result.resumeState!,
    });
    // pendingBrief is the durable record now — same reasoning as pendingHumanReview.
    clearCheckpoint(issue.key);
    return { kind: "brief_pending", issueKey: issue.key };
  }

  if (outcome.failureKind) {
    const message =
      outcome.failureKind === "no_token"
        ? [
            `jira-harness implemented and verified this (cost: $${result.totalCostUsd.toFixed(4)}).`,
            `Committed locally at ${result.worktreeDir} on branch ${branchName}, but GITLAB_TOKEN is not`,
            "configured so no MR was opened. Left in-progress.",
          ].join("\n")
        : outcome.failureKind === "push"
          ? `jira-harness verified the fix but failed to push/open an MR (${outcome.failureReason}).\nCommitted locally at ${result.worktreeDir} on branch ${branchName}. Left in-progress.`
          : [
              `jira-harness did not close this task: ${outcome.failureReason}`,
              `cost: $${result.totalCostUsd.toFixed(4)}, iterations: ${result.iterations.length}`,
              `worktree left at: ${result.worktreeDir}`,
              "Left in-progress for a human to look at.",
            ].join("\n");
    await jira.addComment(issue.key, message);
    setPendingHumanReview({
      issueKey: issue.key,
      title: issue.summary,
      reason: outcome.failureReason!,
      costUsd: result.totalCostUsd,
      worktreeDir: result.worktreeDir,
      branchName,
      gitlabProjectPath: repo.gitlabProjectPath,
    });
    // pendingHumanReview is now the durable record for this task — the checkpoint
    // would just be redundant from here (recoverOrphanedCheckpoints already skips an
    // issue that has one anyway, but clearing it keeps there from being two records
    // of the same thing).
    clearCheckpoint(issue.key);
    return {
      kind: "needs_human",
      issueKey: issue.key,
      costUsd: result.totalCostUsd,
      reason: outcome.failureReason!,
      worktreeDir: result.worktreeDir,
      branchName,
      reviewRounds: result.reviewRounds,
    };
  }

  updateJob({ phase: "commenting" });
  await jira.addComment(
    issue.key,
    `jira-harness opened ${outcome.mrUrl} (cost: $${result.totalCostUsd.toFixed(4)})${testingNotesSection(result.testingNotes)}`,
  );
  await jira.transitionTo(issue.key, config.jira.reviewStatus);
  await cleanupWorktree(repo.path, result.worktreeDir, branchName);
  clearCheckpoint(issue.key);
  return { kind: "closed", issueKey: issue.key, costUsd: result.totalCostUsd, mrUrl: outcome.mrUrl!, reviewRounds: result.reviewRounds };
}

// Shared by the single-repo and cross-repo success comments — the whole point of the
// testing-notes turn is that a tester reads it right there in Jira instead of having
// to go dig through the MR, so it rides along in the same comment as the MR link.
function testingNotesSection(notes: string | undefined): string {
  return notes ? `\n\nКак тестировать:\n${notes}` : "";
}

// Cross-repo: backend and frontend each run their own independent review, under the
// same REVIEW_ENABLED config — so reviewRounds is either present on both or absent on
// both, never a meaningful mix. undefined only when review never ran for either half.
// Takes raw values rather than results objects so a resumed cross-repo brief (where
// backend's own CloseLoopResult no longer exists, only its carried-over reviewRounds
// number) can use it exactly the same way a first attempt does.
function sumReviewRounds(...values: Array<number | undefined>): number | undefined {
  const defined = values.filter((n): n is number => n !== undefined);
  return defined.length > 0 ? defined.reduce((a, b) => a + b, 0) : undefined;
}

// Called only once a task is genuinely done (MR opened, accepted after human review) —
// never for a needs_human outcome, whose worktree/branch stay exactly where
// resolveHumanReview expects to find them. The branch is pushed and the MR is already
// open on GitLab by this point, so deleting the local worktree and branch loses nothing
// — the remote ref `origin/<branch>` the MR is built from is untouched either way.
// Without this, both accumulate on disk forever: confirmed live, nothing was ever
// calling either for a real task before this.
async function cleanupWorktree(repoPath: string, worktreeDir: string, branchName: string): Promise<void> {
  await removeWorktree(repoPath, worktreeDir).catch(() => {});
  await deleteBranch(repoPath, branchName);
}

const MAX_CROSS_REPO_CONTEXT_DIFF_CHARS = 8000; // same weight class as review.ts's own diff cap

// Backend-first, autonomous handoff: no human gate between the two halves (ambiguous
// tickets already got one approval up front, same as any single-repo task — this is
// the execution of that same approved plan, not a second decision point). If the
// backend half doesn't make it, the frontend half is never attempted — there is
// nothing real to build against yet, just the ticket text. If the backend half lands
// but the frontend half doesn't, the backend MR is left standing on its own rather
// than held hostage — it's independently correct and shouldn't wait on the frontend.
async function runCrossRepoJob(
  jira: JiraClient,
  issue: { key: string; summary: string },
  backend: { task: TaskSpec; repo: RepoHandle; branchName: string },
  frontend: { task: TaskSpec; repo: RepoHandle; branchName: string },
): Promise<JobOutcome> {
  updateJob({ phase: "transitioning" });
  await jira.transitionTo(issue.key, config.jira.inProgressStatus);

  const backendOutcome = await closeLoopAndPush(issue, backend.repo, backend.task, backend.branchName);
  return afterBackendAttempt(jira, issue, backend, frontend, backendOutcome);
}

// Everything that happens once a backend attempt (a first try, or a resumed brief)
// comes back: brief, failure, or success into the frontend half. Shared by
// runCrossRepoJob's first attempt and resolveBrief's resumed one for a backend-stage
// brief — same reasoning as handleCloseLoopOutcome for the single-repo path.
async function afterBackendAttempt(
  jira: JiraClient,
  issue: { key: string; summary: string },
  backend: { task: TaskSpec; repo: RepoHandle; branchName: string },
  frontend: { task: TaskSpec; repo: RepoHandle; branchName: string },
  backendOutcome: CloseLoopAndPushOutcome,
): Promise<JobOutcome> {
  const backendResult = backendOutcome.closeLoopResult;

  if (backendOutcome.briefPending) {
    // One-click, same shape as a single-repo brief: paused on the backend's own
    // session, resolveBrief resumes it with the chosen answer and continues into the
    // frontend half exactly as a first attempt would (see CrossRepoBriefContext).
    await jira.addComment(
      issue.key,
      `jira-harness (cross-repo): вопрос от бэкенда — см. Telegram.\n«${backendResult.brief!.question}»`,
    );
    setPendingBrief({
      issueKey: issue.key,
      title: issue.summary,
      task: backend.task,
      brief: backendResult.brief!,
      worktreeDir: backendResult.worktreeDir,
      branchName: backend.branchName,
      gitlabProjectPath: backend.repo.gitlabProjectPath,
      resumeState: backendResult.resumeState!,
      crossRepo: {
        stage: "backend",
        frontendTask: frontend.task,
        frontendBranchName: frontend.branchName,
        frontendGitlabProjectPath: frontend.repo.gitlabProjectPath,
      },
    });
    clearCheckpoint(issue.key);
    return { kind: "brief_pending", issueKey: issue.key };
  }

  if (backendOutcome.failureKind) {
    const reason = `backend: ${backendOutcome.failureReason}`;
    await jira.addComment(
      issue.key,
      [
        `jira-harness (cross-repo): backend half did not close — ${backendOutcome.failureReason}`,
        `cost so far: $${backendResult.totalCostUsd.toFixed(4)}`,
        `backend worktree left at: ${backendResult.worktreeDir}`,
        "Frontend half was not attempted — nothing real to build against yet. Left in-progress.",
      ].join("\n"),
    );
    setPendingHumanReview({
      issueKey: issue.key,
      title: issue.summary,
      reason,
      costUsd: backendResult.totalCostUsd,
      worktreeDir: backendResult.worktreeDir,
      branchName: backend.branchName,
      gitlabProjectPath: backend.repo.gitlabProjectPath,
    });
    clearCheckpoint(issue.key);
    return {
      kind: "needs_human",
      issueKey: issue.key,
      costUsd: backendResult.totalCostUsd,
      reason,
      worktreeDir: backendResult.worktreeDir,
      branchName: backend.branchName,
      reviewRounds: backendResult.reviewRounds,
    };
  }

  // Backend is pushed and its MR opened — hand the frontend turn the real diff instead
  // of letting it guess the new API shape from the ticket text alone.
  const backendDiff = await getWorktreeDiff(backendResult.worktreeDir, config.gitlab.targetBranch);
  const truncatedDiff =
    backendDiff.length > MAX_CROSS_REPO_CONTEXT_DIFF_CHARS
      ? backendDiff.slice(0, MAX_CROSS_REPO_CONTEXT_DIFF_CHARS) + "\n... (обрезано)"
      : backendDiff;
  // Nothing after this point ever reads backend's worktree again — its own MR is
  // already open, independent of whatever happens to the frontend half from here.
  // Clearing the checkpoint here (not just on the two exits below) matters for cross-
  // repo specifically: backend and frontend share the same issue key, so frontend's
  // own checkpoint writes (started below) would otherwise land on the same file backend
  // was still using.
  await cleanupWorktree(backend.repo.path, backendResult.worktreeDir, backend.branchName);
  clearCheckpoint(issue.key);
  const frontendTask: TaskSpec = {
    ...frontend.task,
    description: [
      frontend.task.description,
      "",
      "--- Контекст: бэкенд-часть этой же задачи уже реализована и запушена, дальше реализуется только фронтенд ---",
      `MR бэкенда: ${backendOutcome.mrUrl}`,
      "Фактический дифф бэкенда (ориентируйся на реальный код, а не только на текст задачи):",
      truncatedDiff,
    ].join("\n"),
  };

  const frontendOutcome = await closeLoopAndPush(issue, frontend.repo, frontendTask, frontend.branchName);
  return afterFrontendAttempt(
    jira,
    issue,
    { task: frontendTask, repo: frontend.repo, branchName: frontend.branchName },
    { totalCostUsd: backendResult.totalCostUsd, testingNotes: backendResult.testingNotes, reviewRounds: backendResult.reviewRounds, mrUrl: backendOutcome.mrUrl! },
    frontendOutcome,
  );
}

// Mirror of afterBackendAttempt for the frontend half — shared by the normal handoff
// above and resolveBrief's resumed attempt for a frontend-stage brief. `backendInfo` is
// everything the final combined comment/cost/review totals still need from backend,
// since by this point backend's own worktree is already gone, and on a resume its
// CloseLoopResult never existed in this process at all — only what was carried over in
// CrossRepoBriefContext.
async function afterFrontendAttempt(
  jira: JiraClient,
  issue: { key: string; summary: string },
  frontend: { task: TaskSpec; repo: RepoHandle; branchName: string },
  backendInfo: { totalCostUsd: number; testingNotes?: string; reviewRounds?: number; mrUrl: string },
  frontendOutcome: CloseLoopAndPushOutcome,
): Promise<JobOutcome> {
  const frontendResult = frontendOutcome.closeLoopResult;
  const totalCostUsd = backendInfo.totalCostUsd + frontendResult.totalCostUsd;

  if (frontendOutcome.briefPending) {
    await jira.addComment(
      issue.key,
      `jira-harness (cross-repo): backend done — ${backendInfo.mrUrl}\nвопрос от фронтенда — см. Telegram.\n«${frontendResult.brief!.question}»`,
    );
    setPendingBrief({
      issueKey: issue.key,
      title: issue.summary,
      task: frontend.task,
      brief: frontendResult.brief!,
      worktreeDir: frontendResult.worktreeDir,
      branchName: frontend.branchName,
      gitlabProjectPath: frontend.repo.gitlabProjectPath,
      resumeState: frontendResult.resumeState!,
      crossRepo: {
        stage: "frontend",
        backendMrUrl: backendInfo.mrUrl,
        backendCostUsd: backendInfo.totalCostUsd,
        backendTestingNotes: backendInfo.testingNotes,
        backendReviewRounds: backendInfo.reviewRounds,
      },
    });
    clearCheckpoint(issue.key);
    return { kind: "brief_pending", issueKey: issue.key };
  }

  if (frontendOutcome.failureKind) {
    const reason = `frontend: ${frontendOutcome.failureReason} (backend already opened: ${backendInfo.mrUrl})`;
    await jira.addComment(
      issue.key,
      [
        `jira-harness (cross-repo): backend done — ${backendInfo.mrUrl}`,
        `frontend half did not close — ${frontendOutcome.failureReason}`,
        `cost: $${totalCostUsd.toFixed(4)}`,
        `frontend worktree left at: ${frontendResult.worktreeDir}`,
        "Left in-progress for a human to look at the frontend half — the backend MR stands on its own and doesn't need to wait.",
      ].join("\n"),
    );
    setPendingHumanReview({
      issueKey: issue.key,
      title: issue.summary,
      reason,
      costUsd: totalCostUsd,
      worktreeDir: frontendResult.worktreeDir,
      branchName: frontend.branchName,
      gitlabProjectPath: frontend.repo.gitlabProjectPath,
    });
    clearCheckpoint(issue.key);
    return {
      kind: "needs_human",
      issueKey: issue.key,
      costUsd: totalCostUsd,
      reason,
      worktreeDir: frontendResult.worktreeDir,
      branchName: frontend.branchName,
      reviewRounds: sumReviewRounds(backendInfo.reviewRounds, frontendResult.reviewRounds),
    };
  }

  const crossRepoNotes = [
    backendInfo.testingNotes ? `Бэкенд:\n${backendInfo.testingNotes}` : "",
    frontendResult.testingNotes ? `Фронтенд:\n${frontendResult.testingNotes}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  updateJob({ phase: "commenting" });
  await jira.addComment(
    issue.key,
    [
      "jira-harness (cross-repo) closed both halves:",
      `backend: ${backendInfo.mrUrl}`,
      `frontend: ${frontendOutcome.mrUrl}`,
      `cost: $${totalCostUsd.toFixed(4)}`,
    ].join("\n") + testingNotesSection(crossRepoNotes || undefined),
  );
  await jira.transitionTo(issue.key, config.jira.reviewStatus);
  await cleanupWorktree(frontend.repo.path, frontendResult.worktreeDir, frontend.branchName);
  clearCheckpoint(issue.key);
  return {
    kind: "closed",
    issueKey: issue.key,
    costUsd: totalCostUsd,
    mrUrl: `backend: ${backendInfo.mrUrl}, frontend: ${frontendOutcome.mrUrl}`,
    reviewRounds: sumReviewRounds(backendInfo.reviewRounds, frontendResult.reviewRounds),
  };
}

// The human looked at the diff a needs_human outcome left pending and decided.
// Accept: commit whatever's still uncommitted, push, open the MR, same as the
// loop's own success path. Reject: drop the worktree and hand the ticket back to
// To Do so it can be picked up (and retried) from /start like any other.
export async function resolveHumanReview(accept: boolean): Promise<{ mrUrl: string } | { rejected: true } | null> {
  const pending = getLiveState().pendingHumanReview;
  if (!pending) return null;
  clearPendingHumanReview();

  const jira = new JiraClient(config.jira.baseUrl, config.jira.token);

  const repoPath = repoPathFor(pending.gitlabProjectPath);

  if (!accept) {
    await cleanupWorktree(repoPath, pending.worktreeDir, pending.branchName);
    await jira.addComment(pending.issueKey, "jira-harness: a human reviewed the pending diff and rejected it.");
    await jira.transitionTo(pending.issueKey, config.jira.todoStatus);
    return { rejected: true };
  }

  await commitAll(pending.worktreeDir, `${pending.issueKey}: ${pending.title}\n\nAutomated by jira-harness, accepted by a human after ${pending.reason}.`);
  await pushBranch(pending.worktreeDir, pending.branchName);
  const mr = await createMergeRequest({
    gitlabBaseUrl: config.gitlab.baseUrl,
    token: config.gitlab.token,
    projectPath: pending.gitlabProjectPath,
    sourceBranch: pending.branchName,
    targetBranch: config.gitlab.targetBranch,
    title: `${pending.issueKey}: ${pending.title}`,
    description: `Automated by jira-harness for ${pending.issueKey}, accepted by a human after: ${pending.reason}.`,
  });
  await jira.addComment(pending.issueKey, `jira-harness opened ${mr.webUrl} (accepted by a human after ${pending.reason})`);
  await jira.transitionTo(pending.issueKey, config.jira.reviewStatus);
  await cleanupWorktree(repoPath, pending.worktreeDir, pending.branchName);
  return { mrUrl: mr.webUrl };
}

// The human picked an option for a brief the agent raised instead of guessing (see
// parseBrief in engine/brief.ts). Resumes the exact same claude session the agent
// paused — CloseLoopResumeState skips redoing baseline/acceptance-test setup, which
// would be wrong against a worktree that already has partial work in it — with the
// chosen option woven into the next prompt. Whatever happens next (success, a normal
// failure, or another brief) gets exactly the same handling a first attempt would.
export async function resolveBrief(chosenIndex: number): Promise<QueueRunOutcome | null> {
  const pending = getLiveState().pendingBrief;
  if (!pending) return null;
  clearPendingBrief();

  const jira = new JiraClient(config.jira.baseUrl, config.jira.token);
  const repo = repoConfigFor(pending.gitlabProjectPath);
  const issue = { key: pending.issueKey, summary: pending.title };
  const answerPrompt = buildBriefAnswerPrompt(pending.brief, chosenIndex);

  startJob(pending.issueKey, pending.title, pending.task.description, pending.gitlabProjectPath, config.maxIterations);
  const startedAt = Date.now();
  try {
    const outcome = await closeLoopAndPush(issue, repo, pending.task, pending.branchName, {
      ...pending.resumeState,
      prompt: answerPrompt,
    });

    let jobOutcome: JobOutcome;
    if (pending.crossRepo?.stage === "backend") {
      const frontendRepo = repoConfigFor(pending.crossRepo.frontendGitlabProjectPath);
      jobOutcome = await afterBackendAttempt(
        jira,
        issue,
        { task: pending.task, repo, branchName: pending.branchName },
        { task: pending.crossRepo.frontendTask, repo: frontendRepo, branchName: pending.crossRepo.frontendBranchName },
        outcome,
      );
    } else if (pending.crossRepo?.stage === "frontend") {
      jobOutcome = await afterFrontendAttempt(
        jira,
        issue,
        { task: pending.task, repo, branchName: pending.branchName },
        {
          totalCostUsd: pending.crossRepo.backendCostUsd,
          testingNotes: pending.crossRepo.backendTestingNotes,
          reviewRounds: pending.crossRepo.backendReviewRounds,
          mrUrl: pending.crossRepo.backendMrUrl,
        },
        outcome,
      );
    } else {
      jobOutcome = await handleCloseLoopOutcome(jira, issue, repo, pending.task, pending.branchName, outcome);
    }

    if (jobOutcome.kind === "closed" || jobOutcome.kind === "needs_human") {
      // "cross" matches the repo tag a cross-repo task's own first attempt reports
      // (dispatchIssue) — /metrics groups by this field, and a half's own gitlabProjectPath
      // would misrepresent a cross-repo task as single-repo.
      return { ...jobOutcome, durationMs: Date.now() - startedAt, repo: pending.crossRepo ? "cross" : pending.gitlabProjectPath };
    }
    return jobOutcome;
  } finally {
    finishJob();
  }
}

export async function getPendingHumanReviewDiff(): Promise<string | null> {
  const pending = getLiveState().pendingHumanReview;
  if (!pending) return null;
  return getWorktreeDiff(pending.worktreeDir, config.gitlab.targetBranch);
}

function repoConfigFor(gitlabProjectPath: string): RepoHandle {
  const match = Object.values(config.repos).find((r) => r.gitlabProjectPath === gitlabProjectPath);
  if (!match?.path) throw new Error(`No configured repo for GitLab project "${gitlabProjectPath}"`);
  return match;
}

function repoPathFor(gitlabProjectPath: string): string {
  return repoConfigFor(gitlabProjectPath).path;
}
