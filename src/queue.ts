import { config } from "./config.js";
import { JiraClient, type JiraIssue } from "./jira/client.js";
import { detectRepo, toTaskSpec, type RepoDetection } from "./jira/mapToTask.js";
import { runCloseLoop } from "./engine/loop.js";
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
} from "./bot/liveState.js";
import { commitAll, getWorktreeDiff, removeWorktree, worktreeDirFor } from "./engine/git.js";
import { writeCheckpoint, clearCheckpoint } from "./engine/checkpoint.js";
import { loadState, costSince, countSince, startOfTodayIso } from "./bot/state.js";
import type { CloseLoopResult, GateSpec, QueueRunOutcome, TaskSpec } from "./types.js";

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
  const memoryContext = buildMemoryContextBlock(await readMemoryFiles(repoPath));
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

// Shared by proposeNext (auto-picked, whatever's top of the JQL order) and
// proposeIssueByKey (manually picked from /start's ticket menu).
async function proposeIssue(
  jira: JiraClient,
  issue: JiraIssue,
  onAnalyzing?: (issueKey: string) => void | Promise<void>,
): Promise<ProposeOutcome> {
  const detection = detectRepo(issue);
  if (detection.kind === "unknown" || detection.kind === "ambiguous") {
    const reason =
      detection.kind === "unknown"
        ? "no [backend]/[frontend]/[web] prefix in title or description"
        : "touches both backend and frontend";
    declinedKeys.add(issue.key); // can't route it regardless of approval; no point re-surfacing
    await jira.addComment(
      issue.key,
      `jira-harness: could not determine a single target repository (${reason}). Skipped — left in To Do.`,
    );
    return { kind: "skipped", issueKey: issue.key, reason };
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

  setPendingApproval({
    issueKey: issue.key,
    title: issue.summary,
    repo: detection.kind,
    description: issue.description,
    descriptionShort: issue.description.slice(0, 300),
    plan,
    acceptanceCriteria,
    costUsd,
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
    const reason = "touches both backend and frontend";
    await jira.addComment(
      issue.key,
      "jira-harness: this ticket's prefix spans both backend and frontend. Cross-repo changes aren't automated yet — needs a human to split or drive it. Left in To Do.",
    );
    return { kind: "skipped", issueKey: issue.key, reason };
  }

  const repo = config.repos[detection.kind];
  if (!repo.path) {
    throw new Error(`Repo path for "${detection.kind}" is not configured (set ${detection.kind.toUpperCase()}_REPO_PATH)`);
  }

  const task: TaskSpec = { ...toTaskSpec(issue), acceptanceCriteria };
  const branchName = `harness/${issue.key.toLowerCase()}`;

  startJob(issue.key, issue.summary, issue.description, detection.kind, config.maxIterations);
  try {
    return await runJob(jira, issue, repo, task, branchName);
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

async function runJob(
  jira: JiraClient,
  issue: { key: string; summary: string },
  repo: { path: string; gates: GateSpec[]; gitlabProjectPath: string; acceptanceRunner: string; acceptanceTestExt: string },
  task: ReturnType<typeof toTaskSpec>,
  branchName: string,
): Promise<QueueRunOutcome> {
  updateJob({ phase: "transitioning" });
  await jira.transitionTo(issue.key, config.jira.inProgressStatus);

  // Checkpoint is bookkeeping, not a resume mechanism: if this process dies mid-loop
  // (OOM-kill etc.), the worktree on disk already has whatever the agent last wrote —
  // the checkpoint just means a restart can find it and hand it to a human instead of
  // leaving an untracked worktree rotting in /tmp forever. Cleared in the `finally`
  // below the instant runCloseLoop is no longer in flight, success or not — from that
  // point its own outcome handling (below) owns the worktree.
  let result: CloseLoopResult;
  try {
    result = await runCloseLoop(task, {
      repoPath: repo.path,
      branchName,
      gates: repo.gates,
      maxIterations: config.maxIterations,
      maxBudgetUsd: config.maxBudgetUsd,
      permissionMode: "acceptEdits",
      model: config.models.implement,
      acceptanceTest: config.acceptanceTestsEnabled
        ? { model: config.models.acceptance, runner: repo.acceptanceRunner, ext: repo.acceptanceTestExt }
        : undefined,
      memory: config.memoryEnabled ? { model: config.models.memory, baseBranch: config.gitlab.targetBranch } : undefined,
      onIteration: ({ iteration, phase, costUsd, summary }) => {
        updateJob({ iteration, phase, costUsd, lastTurnSummary: summary });
        writeCheckpoint({
          issueKey: issue.key,
          title: issue.summary,
          branchName,
          worktreeDir: worktreeDirFor(branchName),
          gitlabProjectPath: repo.gitlabProjectPath,
          iteration,
          maxIterations: config.maxIterations,
          costUsd,
          phase,
          savedAt: new Date().toISOString(),
        });
      },
      onLog: appendLog,
    });
  } finally {
    clearCheckpoint(issue.key);
  }

  if (!result.success) {
    await jira.addComment(
      issue.key,
      [
        `jira-harness did not close this task: ${result.stopReason}`,
        `cost: $${result.totalCostUsd.toFixed(4)}, iterations: ${result.iterations.length}`,
        `worktree left at: ${result.worktreeDir}`,
        "Left in-progress for a human to look at.",
      ].join("\n"),
    );
    setPendingHumanReview({
      issueKey: issue.key,
      title: issue.summary,
      reason: result.stopReason,
      costUsd: result.totalCostUsd,
      worktreeDir: result.worktreeDir,
      branchName,
      gitlabProjectPath: repo.gitlabProjectPath,
    });
    return { kind: "needs_human", issueKey: issue.key, costUsd: result.totalCostUsd, reason: result.stopReason, worktreeDir: result.worktreeDir, branchName };
  }

  if (!config.gitlab.token) {
    await jira.addComment(
      issue.key,
      [
        `jira-harness implemented and verified this (cost: $${result.totalCostUsd.toFixed(4)}).`,
        `Committed locally at ${result.worktreeDir} on branch ${branchName}, but GITLAB_TOKEN is not`,
        "configured so no MR was opened. Left in-progress.",
      ].join("\n"),
    );
    const reason = "no GITLAB_TOKEN configured";
    setPendingHumanReview({
      issueKey: issue.key,
      title: issue.summary,
      reason,
      costUsd: result.totalCostUsd,
      worktreeDir: result.worktreeDir,
      branchName,
      gitlabProjectPath: repo.gitlabProjectPath,
    });
    return { kind: "needs_human", issueKey: issue.key, costUsd: result.totalCostUsd, reason, worktreeDir: result.worktreeDir, branchName };
  }

  try {
    updateJob({ phase: "pushing" });
    await pushBranch(result.worktreeDir, branchName);
    updateJob({ phase: "opening_mr" });
    const mr = await createMergeRequest({
      gitlabBaseUrl: config.gitlab.baseUrl,
      token: config.gitlab.token,
      projectPath: repo.gitlabProjectPath,
      sourceBranch: branchName,
      targetBranch: config.gitlab.targetBranch,
      title: `${issue.key}: ${issue.summary}`,
      description: `Automated by jira-harness for ${issue.key}.\n\ncost: $${result.totalCostUsd.toFixed(4)}, iterations: ${result.iterations.length}`,
    });
    updateJob({ phase: "commenting" });
    await jira.addComment(issue.key, `jira-harness opened ${mr.webUrl} (cost: $${result.totalCostUsd.toFixed(4)})`);
    await jira.transitionTo(issue.key, config.jira.reviewStatus);
    return { kind: "closed", issueKey: issue.key, costUsd: result.totalCostUsd, mrUrl: mr.webUrl };
  } catch (err) {
    const reason = `push/MR failed: ${(err as Error).message}`;
    await jira.addComment(
      issue.key,
      `jira-harness verified the fix but failed to push/open an MR: ${(err as Error).message}\nCommitted locally at ${result.worktreeDir} on branch ${branchName}. Left in-progress.`,
    );
    setPendingHumanReview({
      issueKey: issue.key,
      title: issue.summary,
      reason,
      costUsd: result.totalCostUsd,
      worktreeDir: result.worktreeDir,
      branchName,
      gitlabProjectPath: repo.gitlabProjectPath,
    });
    return { kind: "needs_human", issueKey: issue.key, costUsd: result.totalCostUsd, reason, worktreeDir: result.worktreeDir, branchName };
  }
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

  if (!accept) {
    await removeWorktree(repoPathFor(pending.gitlabProjectPath), pending.worktreeDir).catch(() => {});
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
  return { mrUrl: mr.webUrl };
}

export async function getPendingHumanReviewDiff(): Promise<string | null> {
  const pending = getLiveState().pendingHumanReview;
  if (!pending) return null;
  return getWorktreeDiff(pending.worktreeDir, config.gitlab.targetBranch);
}

function repoPathFor(gitlabProjectPath: string): string {
  const match = Object.values(config.repos).find((r) => r.gitlabProjectPath === gitlabProjectPath);
  if (!match?.path) throw new Error(`No configured repo path for GitLab project "${gitlabProjectPath}"`);
  return match.path;
}
