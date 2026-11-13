import { config, type RepoKind } from "./config.js";
import { JiraClient, type JiraIssue } from "./jira/client.js";
import { detectRepo, toTaskSpec, retagTitle, type RepoDetection } from "./jira/mapToTask.js";
import { runCloseLoop } from "./engine/loop.js";
import { buildBriefAnswerPrompt } from "./engine/brief.js";
import { buildContinuationPrompt, buildInterruptedResumePrompt } from "./engine/prompts.js";
import { runClaudeTurn } from "./engine/claudeEngine.js";
import { parseProposalResponse, parseWrongRepoSignal } from "./engine/proposal.js";
import { readMemoryFiles, buildMemoryContextBlock } from "./engine/memory.js";
import { analyzeRepoScope, type RepoScope, type ScopeOptions } from "./engine/repoScope.js";
import { createMergeRequest, deleteRemoteBranch, pushBranch } from "./gitlab.js";
import {
  startJob,
  updateJob,
  finishJob,
  appendLog,
  getLiveState,
  setAnalyzing,
  setPendingApproval,
  clearPendingApproval,
  setPendingHumanReview,
  clearPendingHumanReview,
  setPendingBrief,
  clearPendingBrief,
  type PendingHumanReview,
} from "./bot/liveState.js";
import { commitAll, deleteBranch, getWorktreeDiff, mergeFreshBase, removeWorktree, worktreeDirFor } from "./engine/git.js";
import { buildAutoFixPrompt } from "./engine/fixPrompts.js";
import { buildWorkReportDocument, workReportFilename } from "./engine/workReport.js";
import { generateTestingNotes } from "./engine/testingNotes.js";
import { generateCloseReport } from "./engine/closeReport.js";
import { writeCheckpoint, clearCheckpoint } from "./engine/checkpoint.js";
import { loadState, costSince, countSince, startOfTodayIso, estimateCost, type CostEstimate } from "./bot/state.js";
import type { CloseLoopResult, EngineConfig, GateSpec, QueueRunOutcome, TaskSpec } from "./types.js";
import { existsSync } from "node:fs";

// What runJob itself can determine — it has no notion of elapsed wall-clock time or
// which repo was targeted (that's dispatchIssue's job, wrapping the call). Same shape
// as QueueRunOutcome's needs_human/closed variants minus durationMs/repo; dispatchIssue
// adds those once, after runJob returns, rather than threading them through every one
// of runJob's own return statements.
type JobOutcome =
  | { kind: "busy"; issueKey: string }
  | { kind: "skipped"; issueKey: string; reason: string }
  | { kind: "needs_human"; issueKey: string; costUsd: number; reason: string; worktreeDir: string; branchName: string; reviewRounds?: number }
  | { kind: "closed"; issueKey: string; costUsd: number; mrUrl: string; reviewRounds?: number; report?: string }
  | { kind: "brief_pending"; issueKey: string };

// Jira is bookkeeping around the real work, never a reason to lose it. A comment or
// status change that fails (Jira down, a workflow with no such transition, an expired
// token) used to throw out of the middle of a flow — after the MR was already open but
// before the outcome was recorded, or before a needs_human review was even saved —
// leaving a worktree nobody was told about. Logged and carried on from instead.
async function safeComment(jira: JiraClient, issueKey: string, body: string): Promise<void> {
  try {
    await jira.addComment(issueKey, body);
  } catch (err) {
    appendLog(`⚠️ Не удалось оставить комментарий в ${issueKey}: ${(err as Error).message}`);
    console.error(`[jira] comment on ${issueKey} failed:`, (err as Error).message);
  }
}

async function safeTransition(jira: JiraClient, issueKey: string, status: string): Promise<void> {
  try {
    await jira.transitionTo(issueKey, status);
  } catch (err) {
    appendLog(`⚠️ Не удалось перевести ${issueKey} в «${status}»: ${(err as Error).message}`);
    console.error(`[jira] transition of ${issueKey} to ${status} failed:`, (err as Error).message);
  }
}

// Last line of defence for anything that throws once a task's worktree exists (a
// killed turn, a gate that couldn't run, a git failure): the work on disk becomes a
// needs_human review a person can accept or reject, instead of an error message and an
// orphaned worktree that only a bot restart would ever surface. Rethrows when there's
// no worktree — nothing was started, so there's nothing to hand over.
async function escalateFailure(
  jira: JiraClient,
  issue: { key: string; summary: string },
  gitlabProjectPath: string,
  task: TaskSpec,
  branchName: string,
  err: unknown,
): Promise<JobOutcome> {
  const worktreeDir = worktreeDirFor(branchName);
  if (!existsSync(worktreeDir)) throw err;
  const message = (err as Error)?.message ?? String(err);
  const reason = /killed by SIG|\/kill/.test(message) ? "остановлено вручную (/kill)" : `сбой харнесса: ${message.slice(0, 300)}`;
  const costUsd = getLiveState().currentJob?.costUsd ?? 0;
  setPendingHumanReview({
    issueKey: issue.key,
    title: issue.summary,
    reason,
    costUsd,
    worktreeDir,
    branchName,
    gitlabProjectPath,
    description: task.description,
    acceptanceCriteria: task.acceptanceCriteria,
  });
  clearCheckpoint(issue.key);
  await safeComment(jira, issue.key, `jira-harness: работа прервана (${reason}). Рабочее дерево сохранено: ${worktreeDir}. Ждёт решения человека.`);
  return { kind: "needs_human", issueKey: issue.key, costUsd, reason, worktreeDir, branchName };
}

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
  await safeTransition(jira, issueKey, config.jira.todoStatus);
}

export interface Proposal {
  issueKey: string;
  title: string;
  repo: string;
  descriptionShort: string;
  plan: string;
  // One plain sentence for the CEO (engine/repoScope.ts); absent on older paths.
  summary?: string;
  acceptanceCriteria: string[];
  costUsd: number;
  costEstimate: CostEstimate | null;
}

export type ProposeOutcome =
  | { kind: "empty" }
  | { kind: "paused"; reason: string }
  | { kind: "awaiting_approval" }
  // busyWith names whichever ticket is actually responsible, when known — reproduced
  // live (2026-11-10): a generic "занято" after the double-propose-race fix read as a
  // failure worth retrying, so the user re-clicked /start several times while their own
  // first pick's analysis was still genuinely in flight. Naming the ticket + "это
  // недолго" turns that into "ok, I'll wait" instead.
  | { kind: "busy"; busyWith?: string }
  | { kind: "skipped"; issueKey: string; reason: string }
  // The analysis found nothing to change in either repo. A human decides what that
  // means (see proposeByCodeScope) — it is not a skip.
  | { kind: "nothing_to_do"; issueKey: string; title: string; reasons: Array<{ repo: RepoKind; reason: string }>; costUsd: number }
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
// allowRepoRedirect is only ever true from proposeIssue's single-repo branch below —
// proposeCrossRepoSolution's two calls (one per repo, both genuinely in scope for a
// cross-repo ticket) never pass it, so they get the exact prompt this always used to
// send, unaffected by REPO_RETAG_ENABLED either way.
async function proposeSolution(
  task: TaskSpec,
  repoPath: string,
  allowRepoRedirect?: { thisRepo: RepoKind },
): Promise<{ plan: string; acceptanceCriteria: string[]; costUsd: number; wrongRepo?: RepoKind }> {
  const memoryContext = buildMemoryContextBlock(await readMemoryFiles(repoPath, "pm"), "pm");
  const otherRepo: RepoKind | null = allowRepoRedirect
    ? allowRepoRedirect.thisRepo === "backend"
      ? "frontend"
      : "backend"
    : null;
  const prompt = [
    `Задача ${task.id}: ${task.title}`,
    "",
    task.description,
    memoryContext ? `\n${memoryContext}\n` : "",
    "Не редактируй и не создавай файлы — только изучи код (Read/Grep/Glob).",
    otherRepo
      ? [
          `Ты сейчас смотришь ${allowRepoRedirect!.thisRepo}-репозиторий (так тикет был помечен тегом).`,
          `Если по ходу изучения кода выяснится, что реальный фикс целиком должен быть сделан`,
          `в ${otherRepo} — а в этом репозитории менять нечего вообще — не пиши план по этому`,
          `репозиторию. Вместо этого ответь РОВНО одной строкой, без ПЛАН/КРИТЕРИИ:`,
          `РЕПОЗИТОРИЙ: ${otherRepo}`,
          `Так тикет переанализируют по правильному репозиторию, а не закроют половинчатым`,
          `планом вида "сообщить другой команде". Если репозиторий всё же тот — просто`,
          `отвечай как обычно, без этой строки.`,
          "",
        ].join("\n")
      : "",
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
  const wrongRepo = otherRepo ? (parseWrongRepoSignal(turn.resultText) ?? undefined) : undefined;
  if (wrongRepo) {
    return { plan: "", acceptanceCriteria: [], costUsd: turn.totalCostUsd, wrongRepo };
  }
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

const SCOPE_REPO_RU: Record<RepoKind, string> = { backend: "бэкенд", frontend: "фронтенд" };

// The plan the human approves says which repo was left out and why — "the bot only did
// the frontend" should be something they agreed to, not something they find out later.
export function withSkippedRepos(plan: string, skipped: Array<{ repo: RepoKind; reason: string }>): string {
  if (skipped.length === 0) return plan;
  const lines = skipped.map((s) => `Репозиторий ${SCOPE_REPO_RU[s.repo]} не трогаю: ${s.reason}`);
  return [plan, "", ...lines].join("\n");
}

// What the human added on top of the ticket travels with the task from here on: the
// implement, review and report turns all read TaskSpec.description.
export function withHumanNote(description: string, note?: string): string {
  return note?.trim() ? `${description}\n\nУказание руководителя (выполнить обязательно, важнее формулировок тикета): ${note.trim()}` : description;
}

async function proposeByCodeScope(
  jira: JiraClient,
  issue: JiraIssue,
  onAnalyzing?: (issueKey: string) => void | Promise<void>,
  opts: ScopeOptions = {},
): Promise<ProposeOutcome> {
  await onAnalyzing?.(issue.key);

  const analysis = await analyzeRepoScope(toTaskSpec(issue), opts);
  if (!analysis.scope) {
    // Not a silent skip: "nothing to change" is the analysis's opinion about a ticket a
    // human filed as a bug. Reproduced live (XEN-541): the backend turn said "already
    // enforced", the frontend turn said "this is backend hardening", and the ticket was
    // dropped with a wall of text. The human decides — do it anyway, or skip.
    const why = analysis.skippedRepos.map((s) => `${SCOPE_REPO_RU[s.repo]}: ${s.reason}`).join("; ");
    declinedKeys.add(issue.key); // auto-poll must not pick it again; an explicit pick still can
    await safeComment(jira, issue.key, `jira-harness: анализ кода не нашёл, что менять ни в одном репозитории (${why}). Жду решения человека — делать всё равно или пропустить.`);
    return { kind: "nothing_to_do", issueKey: issue.key, title: issue.summary, reasons: analysis.skippedRepos, costUsd: analysis.costUsd };
  }

  const proposal = {
    issueKey: issue.key,
    title: issue.summary,
    repo: analysis.scope,
    descriptionShort: issue.description.slice(0, 300),
    plan: withSkippedRepos(analysis.plan, analysis.skippedRepos),
    summary: analysis.summary || undefined,
    acceptanceCriteria: analysis.acceptanceCriteria,
    costUsd: analysis.costUsd,
    costEstimate: estimateCost(loadState(), analysis.scope),
  };
  setPendingApproval({ ...proposal, description: withHumanNote(issue.description, opts.note) });
  return { kind: "proposed", proposal };
}

// Shared by proposeNext (auto-picked, whatever's top of the JQL order) and
// proposeIssueByKey (manually picked from /start's ticket menu).
async function proposeIssue(
  jira: JiraClient,
  issue: JiraIssue,
  onAnalyzing?: (issueKey: string) => void | Promise<void>,
  opts: ScopeOptions = {},
): Promise<ProposeOutcome> {
  // Both repos configured: the scope comes from the code (engine/repoScope.ts), and
  // the title's tags are not consulted at all. The tag-based routing below is only what
  // is left for a single-repo installation, where there is nothing to choose between.
  if (config.repos.backend.path && config.repos.frontend.path) {
    return proposeByCodeScope(jira, issue, onAnalyzing, opts);
  }

  const detection = detectRepo(issue);
  if (detection.kind === "unknown") {
    const reason = "no [backend]/[frontend]/[web] prefix in title or description";
    declinedKeys.add(issue.key); // can't route it regardless of approval; no point re-surfacing
    await safeComment(jira, 
      issue.key,
      `jira-harness: could not determine a single target repository (${reason}). Skipped — left in To Do.`,
    );
    return { kind: "skipped", issueKey: issue.key, reason };
  }

  if (detection.kind === "ambiguous") {
    if (!config.repos.backend.path || !config.repos.frontend.path) {
      const reason = "cross-repo ticket but BACKEND_REPO_PATH/FRONTEND_REPO_PATH aren't both configured";
      declinedKeys.add(issue.key);
      await safeComment(jira, issue.key, `jira-harness: ${reason}. Skipped — left in To Do.`);
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

  let repoKind: RepoKind = detection.kind;
  let repo = config.repos[repoKind];
  if (!repo.path) {
    throw new Error(`Repo path for "${repoKind}" is not configured (set ${repoKind.toUpperCase()}_REPO_PATH)`);
  }

  // The analysis turn below can take a while against a real codebase — tell
  // whoever's watching before going quiet, not after (reproduced live: a
  // multi-minute silent gap reads as "it's stuck", not "it's thinking").
  await onAnalyzing?.(issue.key);

  let title = issue.summary;
  const task = toTaskSpec(issue);
  let result = await proposeSolution(task, repo.path, config.repoRetagEnabled ? { thisRepo: repoKind } : undefined);
  let costUsd = result.costUsd;

  // Tagged for the wrong repo (reproduced live, XEN-541: tagged [frontend], real fix
  // was backend-only) — retag and re-analyze against the repo the propose turn actually
  // named, instead of freezing a "tell the other team" non-fix as this ticket's plan.
  // Capped at one redirect: if the SECOND propose turn says "wrong repo" again too
  // (whatever repo that would even mean here — only two exist), just use whatever it
  // came back with rather than ping-ponging forever.
  if (result.wrongRepo && result.wrongRepo !== repoKind && config.repos[result.wrongRepo].path) {
    const correctedTitle = retagTitle(issue.summary, result.wrongRepo);
    await jira.updateSummary(issue.key, correctedTitle);
    await safeComment(jira, 
      issue.key,
      `jira-harness: при анализе выяснилось, что фикс нужен в ${result.wrongRepo}, а не ${repoKind} — поменял тег в заголовке и беру в работу ${result.wrongRepo}.`,
    );
    title = correctedTitle;
    repoKind = result.wrongRepo;
    repo = config.repos[repoKind];
    result = await proposeSolution({ ...task, title: correctedTitle }, repo.path, config.repoRetagEnabled ? { thisRepo: repoKind } : undefined);
    costUsd += result.costUsd;
  }

  const { plan, acceptanceCriteria } = result;
  const costEstimate = estimateCost(loadState(), repoKind);

  setPendingApproval({
    issueKey: issue.key,
    title,
    repo: repoKind,
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
      title,
      repo: repoKind,
      descriptionShort: issue.description.slice(0, 300),
      plan,
      acceptanceCriteria,
      costUsd,
      costEstimate,
    },
  };
}

// Shared by proposeNext/proposeIssueByKey/dispatchIssue — a task shouldn't start while
// ANY of the four pending states (analysis in flight, approval, human-review, brief) is
// unresolved, not just while something is actively executing (currentJob). Reproduced
// live as two real gaps on two separate occasions:
// - pendingBrief specifically was never checked anywhere, so starting a second ticket
//   while a brief sat paused on the first one was one click away.
// - `analyzing` itself didn't exist at all until reproduced live (2026-11-10): a manual
//   dashboard pick and the auto-poll both passed this exact check — at the time, only
//   currentJob/pendingApproval/pendingHumanReview/pendingBrief, none of which exist
//   during the several-second analysis turn itself — and both ran a full, paid analysis
//   before either's setPendingApproval call finally landed. See LiveState.analyzing's
//   own comment for why a boolean set only around the final step isn't enough; it has
//   to cover proposeNext/proposeIssueByKey's ENTIRE body, Jira fetch included.
function hasUnresolvedWork(): boolean {
  const live = getLiveState();
  return Boolean(live.currentJob || live.analyzing || live.pendingApproval || live.pendingHumanReview || live.pendingBrief);
}

// Best-effort "what's actually busy" for the `busy` outcome's message — "searching" is
// proposeNext's own placeholder before it's picked a concrete ticket off the queue, so
// it's deliberately not surfaced (nothing useful to name yet). Exported for its own unit
// test — the rest of this file's propose/dispatch functions are integration-shaped
// (real Jira/git/claude calls), too heavy to unit test directly, but this one is pure.
export function whatsBusy(): string | undefined {
  const live = getLiveState();
  if (live.currentJob) return live.currentJob.issueKey;
  if (live.analyzing && live.analyzing !== "searching") return live.analyzing;
  if (live.pendingHumanReview) return live.pendingHumanReview.issueKey;
  if (live.pendingBrief) return live.pendingBrief.issueKey;
  return undefined;
}

export async function proposeNext(onAnalyzing?: (issueKey: string) => void | Promise<void>): Promise<ProposeOutcome> {
  const paused = checkDailyCaps();
  if (paused) return paused;
  if (getLiveState().pendingApproval) return { kind: "awaiting_approval" };
  if (hasUnresolvedWork()) return { kind: "busy", busyWith: whatsBusy() };

  // Claimed synchronously, right here — no `await` between the check above and this —
  // so a second concurrent call can't pass the same check before this one's analysis
  // even starts. Cleared in `finally` no matter how this ends.
  setAnalyzing("searching");
  try {
    const jira = new JiraClient(config.jira.baseUrl, config.jira.token);
    const issues = await jira.searchIssues(QUEUE_JQL());
    const issue = issues.find((i) => !declinedKeys.has(i.key));
    if (!issue) return { kind: "empty" };

    setAnalyzing(issue.key);
    return await proposeIssue(jira, issue, onAnalyzing);
  } finally {
    setAnalyzing(null);
  }
}

// Manually picked from /start's ticket menu — same guards as proposeNext, just
// skipping straight to a specific ticket instead of taking whatever's top of the JQL.
export async function proposeIssueByKey(
  issueKey: string,
  onAnalyzing?: (issueKey: string) => void | Promise<void>,
  opts: ScopeOptions = {},
): Promise<ProposeOutcome> {
  const paused = checkDailyCaps();
  if (paused) return paused;
  if (getLiveState().pendingApproval) return { kind: "awaiting_approval" };
  if (hasUnresolvedWork()) return { kind: "busy", busyWith: whatsBusy() };

  setAnalyzing(issueKey);
  try {
    const jira = new JiraClient(config.jira.baseUrl, config.jira.token);
    const issue = await jira.getIssue(issueKey);
    return await proposeIssue(jira, issue, onAnalyzing, opts);
  } finally {
    setAnalyzing(null);
  }
}

// Dispatches whatever's currently pending approval. Returns null if nothing
// was pending (e.g. a stale button click after a restart or a second click).
export async function confirmPending(): Promise<QueueRunOutcome | null> {
  const pending = getLiveState().pendingApproval;
  if (!pending) return null;
  clearPendingApproval();

  const jira = new JiraClient(config.jira.baseUrl, config.jira.token);
  const issue: JiraIssue = { key: pending.issueKey, summary: pending.title, description: pending.description };
  let outcome: QueueRunOutcome;
  try {
    outcome = await dispatchIssue(jira, issue, pending.acceptanceCriteria, approvedScope(pending.repo));
  } catch (err) {
    // Threw before any work existed to hand over (escalateFailure covers the rest).
    // The approved proposal — and the analysis already paid for — goes back as it was,
    // so "Подтвердить" can simply be pressed again once whatever broke is fixed.
    const live = getLiveState();
    if (!live.pendingApproval && !live.pendingHumanReview && !live.pendingBrief) setPendingApproval(pending);
    throw err;
  }
  // "busy" means it never started — same reasoning.
  if (outcome.kind === "busy") {
    if (!getLiveState().pendingApproval) setPendingApproval(pending);
    return outcome;
  }
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

// budgetOnly: for continuing a task that's already counted — the money cap still
// applies, the tasks-per-day cap is about starting new ones.
function checkDailyCaps(opts: { budgetOnly?: boolean } = {}): { kind: "paused"; reason: string } | null {
  const persisted = loadState();
  const todayIso = startOfTodayIso();
  const spentToday = costSince(persisted, todayIso);
  const tasksToday = countSince(persisted, todayIso);
  if (spentToday >= config.dailyBudgetUsd) {
    return { kind: "paused", reason: `дневной бюджет исчерпан ($${spentToday.toFixed(2)} из $${config.dailyBudgetUsd}) — подними DAILY_BUDGET_USD или дождись завтра` };
  }
  if (!opts.budgetOnly && tasksToday >= config.maxTasksPerDay) {
    return { kind: "paused", reason: `daily task cap reached (${tasksToday}/${config.maxTasksPerDay})` };
  }
  return null;
}

// The ONLY path that actually starts real work — reached exclusively from
// confirmPending(), after a human has approved a proposal (pendingApproval) that
// already went through proposeIssue()'s analysis turn. runQueueOnce/proposeIssueByKey/
// the dashboard's "start" all propose now, never dispatch directly (see each of their
// own comments for why that used to be a real gap). acceptanceCriteria is always
// confirmPending's own pending.acceptanceCriteria here — frozen at propose time,
// nothing after this regenerates or edits it, the close loop only ever reads it for
// context.
// The scope a human approved, as dispatch's routing input. Anything else (a proposal
// persisted by an older build, say) falls back to the title's tags.
export function approvedScope(repo: string): RepoScope | undefined {
  return repo === "backend" || repo === "frontend" || repo === "cross" ? repo : undefined;
}

async function dispatchIssue(
  jira: JiraClient,
  issue: JiraIssue,
  acceptanceCriteria: string[],
  scope?: RepoScope,
): Promise<QueueRunOutcome> {
  // Final gate right before real work starts, not just currentJob — a pendingBrief/
  // pendingHumanReview with no currentJob behind it (the close loop already returned,
  // finishJob() already ran) would otherwise let a second task start while the first
  // one's still waiting on a human. Every caller (confirmPending, resolveBrief's
  // continuations) already checked this earlier in its own flow, but this is the one
  // chokepoint every path funnels through before touching a worktree.
  if (hasUnresolvedWork()) {
    return { kind: "busy", issueKey: issue.key };
  }

  // What was approved is what runs: the proposal's own scope decides the repos, so a
  // tag in the title can't route the work somewhere the analysis didn't.
  const detection: RepoDetection = scope ? { kind: scope === "cross" ? "ambiguous" : scope } : detectRepo(issue);
  if (detection.kind === "unknown") {
    const reason = "no [backend]/[frontend]/[web] prefix in title or description";
    await safeComment(jira, 
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
      await safeComment(jira, issue.key, `jira-harness: ${reason}. Left in To Do.`);
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
      let outcome: JobOutcome;
      try {
        outcome = await runCrossRepoJob(
          jira,
          issue,
          { task: backendTask, repo: backendRepo, branchName: backendBranch },
          { task: frontendTask, repo: frontendRepo, branchName: frontendBranch },
        );
      } catch (err) {
        // Whichever half was in flight: the frontend worktree only exists once the
        // backend half is already pushed.
        outcome = existsSync(worktreeDirFor(frontendBranch))
          ? await escalateFailure(jira, issue, frontendRepo.gitlabProjectPath, frontendTask, frontendBranch, err)
          : await escalateFailure(jira, issue, backendRepo.gitlabProjectPath, backendTask, backendBranch, err);
      }
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

// Reproduced live as a real gap: this used to search Jira and call dispatchIssue()
// directly — the entire close loop (implement, review, push, open MR) with no propose
// step and no human ever seeing a plan or cost estimate first. Exactly the gap the
// Telegram pick:/confirm: flow exists to close, just bypassed entirely by running this
// on a cron schedule the way HANDOFF.md itself used to recommend. Now a single
// `queue` invocation only ever proposes (same as proposeNext/a Telegram pick) and
// persists pendingApproval — still needs an actual human approval (via a running bot,
// or the dashboard) before anything real happens. See HANDOFF.md §7/§9 for the fuller
// reasoning and why "bot running continuously, with its own poll loop" replaced "queue
// on cron" as the recommended way to keep the queue moving.
export async function runQueueOnce(): Promise<ProposeOutcome> {
  return proposeNext();
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

// "stuck", "review_blocked", "gate_integrity_violation", "context_budget",
// "rebase_conflict" and "agent_error" all have more to say than their own bare word —
// naming the repeated gate(s), the actual blocking finding(s), the specific tampering
// caught, the token count, the conflict output, or (agent_error, reproduced live on
// XEN-541: was the one left out, said nothing beyond the word itself) the failing
// turn's own resultText. Saves a human from re-deriving any of that from raw gate
// output, re-running the review turn, or just guessing. Pure and exported for its own
// test — the rest of closeLoopAndPush is integration-shaped (real git/claude calls).
export function buildFailureReason(result: CloseLoopResult): string {
  if (result.stopReason === "stuck" && result.stuckGates?.length) {
    return `stuck (same failure repeated in: ${result.stuckGates.join(", ")})`;
  }
  if (result.stopReason === "review_blocked" && result.reviewFindings?.length) {
    const blocking = result.reviewFindings.filter((f) => f.blocking);
    const rounds = result.reviewRounds ? ` после ${result.reviewRounds} раунд(ов) с разработчиком` : "";
    return `review_blocked${rounds}: ${blocking.map((f) => f.description).join("; ")}`;
  }
  if (result.stopReason === "gate_integrity_violation" && result.gateIntegrityViolations?.length) {
    return `gate_integrity_violation: ${result.gateIntegrityViolations.join("; ")}`;
  }
  if (result.stopReason === "context_budget" && result.contextTokens) {
    const failing = result.resumeState?.failedGates?.map((g) => g.name).join(", ");
    return `context_budget: контекст сессии ~${Math.round(result.contextTokens / 1000)}k токенов${failing ? `, не прошли гейты: ${failing}` : ""}`;
  }
  if (result.stopReason === "rebase_conflict" && result.rebaseConflictOutput) {
    return `rebase_conflict (dev moved on while this was paused, and the two don't merge cleanly): ${result.rebaseConflictOutput.slice(0, 1000)}`;
  }
  if (result.stopReason === "agent_error" && result.iterations.length > 0) {
    const lastTurnText = result.iterations[result.iterations.length - 1].turn.resultText.trim();
    if (lastTurnText) return `agent_error: ${lastTurnText.slice(0, 1000)}`;
  }
  return result.stopReason;
}

// The actual "do the work" step, shared by the single-repo (runJob) and cross-repo
// (runCrossRepoJob) dispatch paths. Deliberately does none of the Jira
// commenting/status-transition side effects — a single-repo task and a cross-repo
// task need different comments/transitions around this same core step (one comment
// immediately vs. one combined comment only once both halves are known), so folding
// them in here would just mean every caller immediately undoing half of them.
//
// Exported (2026-11-10) for manual resume-with-a-custom-prompt intervention: reproduced
// live (XEN-540) that continueNeedsHuman's own buildContinuationPrompt — "here's the
// whole diff, re-review it against every criterion" — can burn an entire fresh
// session's context budget on broad re-verification without ever reaching a single
// edit, repeatedly, when what's actually needed is "here's the one concrete gate
// failure, fix just that." continueNeedsHuman itself still always uses the generic
// prompt (right for the common case); this export is the deliberate escape hatch for
// when it isn't working.
export async function closeLoopAndPush(
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
      description: task.description,
      acceptanceCriteria: task.acceptanceCriteria,
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
    maxBudgetUsd: config.maxBudgetUsd + (resumeFrom?.budgetExtensionUsd ?? 0),
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
    closeReport: config.closeReportEnabled
      ? { model: config.models.report, baseBranch: config.gitlab.targetBranch }
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
    return { closeLoopResult: result, failureReason: buildFailureReason(result), failureKind: "loop" };
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
  await safeTransition(jira, issue.key, config.jira.inProgressStatus);

  try {
    const outcome = await closeLoopAndPush(issue, repo, task, branchName);
    return await handleCloseLoopOutcome(jira, issue, repo, task, branchName, outcome);
  } catch (err) {
    return escalateFailure(jira, issue, repo.gitlabProjectPath, task, branchName, err);
  }
}

// Shared by runJob's first attempt and resolveBrief's resumed attempt — a resumed
// session can succeed, fail, or raise ANOTHER brief, and all three need exactly the
// same handling a first attempt would get. Exported alongside closeLoopAndPush above,
// same reason.
export async function handleCloseLoopOutcome(
  jira: JiraClient,
  issue: { key: string; summary: string },
  repo: RepoHandle,
  task: TaskSpec,
  branchName: string,
  outcome: CloseLoopAndPushOutcome,
): Promise<JobOutcome> {
  const result = outcome.closeLoopResult;

  if (outcome.briefPending) {
    await safeComment(jira, 
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
    await safeComment(jira, issue.key, message);
    setPendingHumanReview({
      issueKey: issue.key,
      title: issue.summary,
      reason: outcome.failureReason!,
      costUsd: result.totalCostUsd,
      worktreeDir: result.worktreeDir,
      branchName,
      gitlabProjectPath: repo.gitlabProjectPath,
      description: task.description,
      acceptanceCriteria: task.acceptanceCriteria,
      resumeState: result.resumeState,
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
  await safeComment(jira, 
    issue.key,
    `jira-harness opened ${outcome.mrUrl} (cost: $${result.totalCostUsd.toFixed(4)})${testingNotesSection(result.testingNotes)}`,
  );
  await attachWorkReport(jira, issue, task, { closeReport: result.closeReport, testingNotes: result.testingNotes });
  await safeTransition(jira, issue.key, config.jira.reviewStatus);
  await cleanupWorktree(repo.path, result.worktreeDir, branchName);
  clearCheckpoint(issue.key);
  return {
    kind: "closed",
    issueKey: issue.key,
    costUsd: result.totalCostUsd,
    mrUrl: outcome.mrUrl!,
    reviewRounds: result.reviewRounds,
    report: result.closeReport,
  };
}

// Shared by the single-repo and cross-repo success comments — the whole point of the
// testing-notes turn is that a tester reads it right there in Jira instead of having
// to go dig through the MR, so it rides along in the same comment as the MR link.
function testingNotesSection(notes: string | undefined): string {
  return notes ? `\n\nКак тестировать:\n${notes}` : "";
}

// Shared by the single-repo and cross-repo success paths — attaches the composed
// closeReport/testingNotes document to the Jira issue right as it leaves "in progress",
// so a tester opens the ticket to a document instead of digging through the comment
// thread. No extra LLM turn (reuses text already generated), and never blocks the task
// closing: a failed upload (Jira attachments disabled server-side, a permissions issue)
// is logged and swallowed, same as a failed testingNotes/closeReport turn itself.
// Used only by resolveHumanReview's accept path below — the normal close flow already
// has testingNotes/closeReport generated as part of runCloseLoop itself (see
// runPostImplementSuccess), but a human-accepted needs_human never went through that
// loop at all, so there's nothing to attach yet. Generates them fresh from the final,
// already-committed worktree before composing the same attachment a normal close gets.
// Best-effort like attachWorkReport itself: any failure here is logged and swallowed,
// never blocks accepting the task.
async function generateAndAttachWorkReport(
  jira: JiraClient,
  issue: { key: string; summary: string },
  task: TaskSpec,
  worktreeDir: string,
): Promise<void> {
  let testingNotes: string | undefined;
  let closeReport: string | undefined;
  try {
    if (config.testingNotesEnabled) {
      const result = await generateTestingNotes(worktreeDir, task, { model: config.models.testing, baseBranch: config.gitlab.targetBranch });
      testingNotes = result.notes;
    }
    if (config.closeReportEnabled) {
      const result = await generateCloseReport(worktreeDir, task, { model: config.models.report, baseBranch: config.gitlab.targetBranch });
      closeReport = result.report;
    }
  } catch (err) {
    appendLog(`⚠️ Не удалось сгенерировать отчёт для ${issue.key} после ручного принятия: ${(err as Error).message}`);
    return;
  }
  await attachWorkReport(jira, issue, task, { testingNotes, closeReport });
}

async function attachWorkReport(
  jira: JiraClient,
  issue: { key: string; summary: string },
  task: { id: string; title: string },
  pieces: { closeReport?: string; testingNotes?: string },
): Promise<void> {
  if (!config.workReportEnabled) return;
  const document = buildWorkReportDocument(task, pieces);
  if (!document) return;
  try {
    await jira.addAttachment(issue.key, workReportFilename(issue.key), document);
  } catch (err) {
    appendLog(`⚠️ Не удалось прикрепить отчёт к ${issue.key}: ${(err as Error).message}`);
  }
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
  await safeTransition(jira, issue.key, config.jira.inProgressStatus);

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
    await safeComment(jira, 
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
    await safeComment(jira, 
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
      description: backend.task.description,
      acceptanceCriteria: backend.task.acceptanceCriteria,
      // Deliberately NOT resumeState: backendResult.resumeState — continueNeedsHuman
      // only knows how to finish a single repo (push, open its MR, done). A cross-repo
      // backend half that continues and succeeds still needs to hand its diff to the
      // frontend half afterward (see the brief_pending branch above, a few lines up,
      // for the real handoff) — continueNeedsHuman has no path to do that, so offering
      // it here would silently skip the frontend half entirely on success. Scoped out
      // rather than half-built; the "🔄 Продолжить" button simply won't appear for a
      // cross-repo backend-half needs_human until this is worth building properly.
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
    {
      totalCostUsd: backendResult.totalCostUsd,
      testingNotes: backendResult.testingNotes,
      closeReport: backendResult.closeReport,
      reviewRounds: backendResult.reviewRounds,
      mrUrl: backendOutcome.mrUrl!,
    },
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
  backendInfo: { totalCostUsd: number; testingNotes?: string; closeReport?: string; reviewRounds?: number; mrUrl: string },
  frontendOutcome: CloseLoopAndPushOutcome,
): Promise<JobOutcome> {
  const frontendResult = frontendOutcome.closeLoopResult;
  const totalCostUsd = backendInfo.totalCostUsd + frontendResult.totalCostUsd;

  if (frontendOutcome.briefPending) {
    await safeComment(jira, 
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
        backendCloseReport: backendInfo.closeReport,
        backendReviewRounds: backendInfo.reviewRounds,
      },
    });
    clearCheckpoint(issue.key);
    return { kind: "brief_pending", issueKey: issue.key };
  }

  if (frontendOutcome.failureKind) {
    const reason = `frontend: ${frontendOutcome.failureReason} (backend already opened: ${backendInfo.mrUrl})`;
    await safeComment(jira, 
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
      description: frontend.task.description,
      acceptanceCriteria: frontend.task.acceptanceCriteria,
      // Deliberately NOT resumeState: frontendResult.resumeState — same reasoning as
      // the backend-half call site above: continueNeedsHuman has no access to
      // backendInfo (backend's own MR/cost/testingNotes), which afterFrontendAttempt's
      // own success path needs for the combined "both halves done" Jira comment.
      // Reusing the generic single-repo path here would silently drop the backend MR
      // reference from that comment. Scoped out rather than half-built.
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
  // Unlike testingNotes (Jira, for a tester), the close report is for whoever asked
  // for the ticket and never sees Jira comments — it only ever reaches the closing
  // Telegram message, combined here the same way crossRepoNotes combines above.
  const crossRepoReport = [backendInfo.closeReport, frontendResult.closeReport].filter(Boolean).join(" ");

  updateJob({ phase: "commenting" });
  await safeComment(jira, 
    issue.key,
    [
      "jira-harness (cross-repo) closed both halves:",
      `backend: ${backendInfo.mrUrl}`,
      `frontend: ${frontendOutcome.mrUrl}`,
      `cost: $${totalCostUsd.toFixed(4)}`,
    ].join("\n") + testingNotesSection(crossRepoNotes || undefined),
  );
  await attachWorkReport(
    jira,
    issue,
    { id: issue.key, title: issue.summary },
    { closeReport: crossRepoReport || undefined, testingNotes: crossRepoNotes || undefined },
  );
  await safeTransition(jira, issue.key, config.jira.reviewStatus);
  await cleanupWorktree(frontend.repo.path, frontendResult.worktreeDir, frontend.branchName);
  clearCheckpoint(issue.key);
  return {
    kind: "closed",
    issueKey: issue.key,
    costUsd: totalCostUsd,
    mrUrl: `backend: ${backendInfo.mrUrl}, frontend: ${frontendOutcome.mrUrl}`,
    reviewRounds: sumReviewRounds(backendInfo.reviewRounds, frontendResult.reviewRounds),
    report: crossRepoReport || undefined,
  };
}

// The human looked at the diff a needs_human outcome left pending and decided.
// Accept: commit whatever's still uncommitted, push, open the MR, same as the
// loop's own success path. Reject: drop the worktree and hand the ticket back to
// To Do so it can be picked up (and retried) from /start like any other.
export async function resolveHumanReview(
  accept: boolean,
): Promise<{ mrUrl: string; issueKey: string; costUsd: number; repo: string } | { rejected: true } | null> {
  const pending = getLiveState().pendingHumanReview;
  if (!pending) return null;
  clearPendingHumanReview();
  try {
    return await resolvePendingHumanReview(pending, accept);
  } catch (err) {
    // A failed push or MR used to leave the review cleared: worktree on disk, no
    // buttons, ticket stuck "in progress". Put it back exactly as it was — the same
    // button works again once the cause is fixed.
    if (!getLiveState().pendingHumanReview) setPendingHumanReview(pending);
    throw err;
  }
}

async function resolvePendingHumanReview(
  pending: PendingHumanReview,
  accept: boolean,
): Promise<{ mrUrl: string; issueKey: string; costUsd: number; repo: string } | { rejected: true }> {
  const jira = new JiraClient(config.jira.baseUrl, config.jira.token);

  const repoPath = repoPathFor(pending.gitlabProjectPath);

  if (!accept) {
    // The branch may already be on the remote (verified, pushed, then the MR failed) —
    // left there, the next attempt at this ticket couldn't push.
    await deleteRemoteBranch(repoPath, pending.branchName);
    await cleanupWorktree(repoPath, pending.worktreeDir, pending.branchName);
    await safeComment(jira, pending.issueKey, "jira-harness: a human reviewed the pending diff and rejected it.");
    await safeTransition(jira, pending.issueKey, config.jira.todoStatus);
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
  await safeComment(jira, pending.issueKey, `jira-harness opened ${mr.webUrl} (accepted by a human after ${pending.reason})`);
  await generateAndAttachWorkReport(
    jira,
    { key: pending.issueKey, summary: pending.title },
    { id: pending.issueKey, title: pending.title, description: pending.description, acceptanceCriteria: pending.acceptanceCriteria },
    pending.worktreeDir,
  );
  await safeTransition(jira, pending.issueKey, config.jira.reviewStatus);
  await cleanupWorktree(repoPath, pending.worktreeDir, pending.branchName);
  return { mrUrl: mr.webUrl, issueKey: pending.issueKey, costUsd: pending.costUsd, repo: pending.gitlabProjectPath };
}

// 8000 used to be the cap — a fraction of a real multi-file task's diff, handed to a
// session whose only knowledge of the work so far IS this diff.
const MAX_CONTINUATION_DIFF_CHARS = 40_000;

function clipDiff(diff: string): string {
  if (diff.length <= MAX_CONTINUATION_DIFF_CHARS) return diff;
  return `${diff.slice(0, MAX_CONTINUATION_DIFF_CHARS)}\n... (diff обрезан — остальное прочитай прямо в файлах рабочего дерева)`;
}

// A human explicitly chose to continue a context_budget needs_human with a fresh
// session (the "🔄 Продолжить" button — see PendingHumanReview.resumeState and
// CloseLoopResumeState.freshSession for why this is opt-in, never automatic). Only
// ever reachable when resumeState is set, which is itself only ever set for a
// single-repo task (see the two commented-out cross-repo call sites above) — no
// crossRepo branching needed here the way resolveBrief has.
// "🛠 Решить самому": the same continuation, available for every stop that left a
// resume state (all of them since loop.ts withFixResumeState), with a first prompt that
// says what stopped the last attempt (engine/fixPrompts.ts), a fresh MAX_BUDGET_USD on
// top of what was already spent, and — for a rebase conflict — dev merged in first so
// the agent can resolve the conflict itself. A push/MR failure needs no agent; bot.ts
// sends that one straight to resolveHumanReview(true).
export function autoFixNeedsHuman(opts: { capUsd?: number } = {}): Promise<QueueRunOutcome | null> {
  return continueNeedsHuman({ autoFix: true, capUsd: opts.capUsd });
}

// Budget on top of MAX_BUDGET_USD for a fix run: a full fresh allowance by default; with
// a cap for the whole task (autopilot), no more than what keeps the total under it.
export function fixBudgetExtension(spentUsd: number, maxBudgetUsd: number, capUsd?: number): number {
  if (capUsd === undefined) return spentUsd;
  return Math.max(0, Math.min(spentUsd, capUsd - maxBudgetUsd));
}

export function canAutoFix(pending: { reason: string; resumeState?: unknown }): boolean {
  return Boolean(pending.resumeState) || isPushFailure(pending.reason);
}

export function isPushFailure(reason: string): boolean {
  return reason.startsWith("push/MR failed");
}

export async function continueNeedsHuman(opts: { autoFix?: boolean; capUsd?: number } = {}): Promise<QueueRunOutcome | null> {
  const pending = getLiveState().pendingHumanReview;
  if (!pending?.resumeState) return null;
  // Before anything is cleared: a continuation is a new paid session, and it used to
  // skip the daily cap entirely (only a brand-new task's propose step checked it).
  const paused = checkDailyCaps({ budgetOnly: true });
  if (paused) return paused;
  clearPendingHumanReview();

  const jira = new JiraClient(config.jira.baseUrl, config.jira.token);
  const repo = repoConfigFor(pending.gitlabProjectPath);
  const issue = { key: pending.issueKey, summary: pending.title };
  const task: TaskSpec = {
    id: pending.issueKey,
    title: pending.title,
    description: pending.description,
    acceptanceCriteria: pending.acceptanceCriteria,
  };

  // startJob before the first await (getWorktreeDiff) — same ordering resolveBrief/
  // resolveHumanReview already rely on: clearPendingHumanReview() just above and
  // startJob() here both have to land with no await between them, or hasUnresolvedWork()
  // would see neither pendingHumanReview nor currentJob set for a real tick and let a
  // second proposal slip in underneath this one.
  startJob(pending.issueKey, pending.title, pending.description, pending.gitlabProjectPath, config.maxIterations);
  const startedAt = Date.now();
  try {
    const resumeState = pending.resumeState;
    const conflict = opts.autoFix && /^(?:(?:backend|frontend): )?rebase_conflict/.test(pending.reason);
    const conflictedFiles = conflict ? (await mergeFreshBase(resumeState.worktreeDir, config.gitlab.targetBranch)).conflictedFiles : [];
    // A fresh session knows nothing — replay the diff plus whatever the stopped
    // session's own gates last said. A same-session resume (agent_error) already has
    // all of that in its history.
    const freshDiff = async (): Promise<string> => clipDiff(await getWorktreeDiff(resumeState.worktreeDir, config.gitlab.targetBranch));
    const prompt = !resumeState.freshSession
      ? buildInterruptedResumePrompt()
      : opts.autoFix
        ? buildAutoFixPrompt(task, pending.reason, await freshDiff(), config.briefsEnabled, resumeState.failedGates, conflictedFiles)
        : buildContinuationPrompt(task, await freshDiff(), config.briefsEnabled, resumeState.failedGates);
    const outcome = await closeLoopAndPush(issue, repo, task, pending.branchName, {
      ...resumeState,
      prompt,
      ...(opts.autoFix
        ? { iteration: 0, skipRebase: conflict, budgetExtensionUsd: fixBudgetExtension(resumeState.totalCostUsd, config.maxBudgetUsd, opts.capUsd) }
        : {}),
    });
    const jobOutcome = await handleCloseLoopOutcome(jira, issue, repo, task, pending.branchName, outcome);
    // pending.costUsd is exactly what the needs_human record that led here already put
    // into history — see costAlreadyRecordedUsd's own comment (types.ts).
    if (jobOutcome.kind === "brief_pending") carryRecordedCost(pending.costUsd);
    if (jobOutcome.kind === "closed" || jobOutcome.kind === "needs_human") {
      return { ...jobOutcome, durationMs: Date.now() - startedAt, repo: pending.gitlabProjectPath, costAlreadyRecordedUsd: pending.costUsd };
    }
    return jobOutcome;
  } catch (err) {
    // Same contract as resolveHumanReview: whatever broke, the review comes back (with
    // its resume state) rather than vanishing along with its buttons.
    const live = getLiveState();
    const reason = `${pending.reason} · продолжение не удалось: ${((err as Error)?.message ?? String(err)).slice(0, 200)}`;
    const costUsd = Math.max(pending.costUsd, live.currentJob?.costUsd ?? 0);
    if (!live.pendingHumanReview && !live.pendingBrief) setPendingHumanReview({ ...pending, reason, costUsd });
    return {
      kind: "needs_human",
      issueKey: pending.issueKey,
      costUsd,
      reason,
      worktreeDir: pending.worktreeDir,
      branchName: pending.branchName,
      durationMs: Date.now() - startedAt,
      repo: pending.gitlabProjectPath,
      costAlreadyRecordedUsd: pending.costUsd,
    };
  } finally {
    finishJob();
  }
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
  const paused = checkDailyCaps({ budgetOnly: true });
  if (paused) return paused;
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
          closeReport: pending.crossRepo.backendCloseReport,
          reviewRounds: pending.crossRepo.backendReviewRounds,
          mrUrl: pending.crossRepo.backendMrUrl,
        },
        outcome,
      );
    } else {
      jobOutcome = await handleCloseLoopOutcome(jira, issue, repo, pending.task, pending.branchName, outcome);
    }

    const alreadyRecorded = pending.recordedCostUsd ?? 0;
    if (jobOutcome.kind === "brief_pending") carryRecordedCost(alreadyRecorded);
    if (jobOutcome.kind === "closed" || jobOutcome.kind === "needs_human") {
      // "cross" matches the repo tag a cross-repo task's own first attempt reports
      // (dispatchIssue) — /metrics groups by this field, and a half's own gitlabProjectPath
      // would misrepresent a cross-repo task as single-repo.
      return {
        ...jobOutcome,
        durationMs: Date.now() - startedAt,
        repo: pending.crossRepo ? "cross" : pending.gitlabProjectPath,
        costAlreadyRecordedUsd: alreadyRecorded || undefined,
      };
    }
    return jobOutcome;
  } catch (err) {
    // The question goes back as it was — answering it again is the retry.
    const live = getLiveState();
    if (!live.pendingBrief && !live.pendingHumanReview) setPendingBrief(pending);
    throw err;
  } finally {
    finishJob();
  }
}

// A continuation that pauses on a brief hasn't recorded anything new yet — the amount
// already in history has to ride along on the pending brief, or resolveBrief's eventual
// outcome would record the whole cumulative cost a second time.
function carryRecordedCost(recordedCostUsd: number): void {
  const next = getLiveState().pendingBrief;
  if (next && recordedCostUsd > 0) setPendingBrief({ ...next, recordedCostUsd });
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
