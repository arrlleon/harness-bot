import { runClaudeTurn } from "./claudeEngine.js";
import { getWorktreeDiff } from "./git.js";
import type { ReviewFinding, TaskSpec } from "../types.js";

export interface ReviewOutcome {
  findings: ReviewFinding[];
  costUsd: number;
  reason?: string; // set when the turn itself errored — findings is then always []
}

// Deliberately asked NOT to re-check what gates/tests already cover — a reviewer that
// repeats "tests pass" is noise, not signal. The whole point of this step is to catch
// the category of problem automated checks structurally can't: architectural
// decisions, security issues a passing test doesn't exercise, edge cases nobody wrote
// a test for, convention violations.
// 8000 used to be the cap — on a real multi-file task (XEN-540: ~50KB of diff) the
// reviewer saw the first two files and signed off on the rest unseen.
const MAX_REVIEW_DIFF_CHARS = 60_000;

function truncationNote(diffText: string): string[] {
  if (diffText.length <= MAX_REVIEW_DIFF_CHARS) return [];
  const files = [...diffText.matchAll(/^diff --git a\/(.+?) b\//gm)].map((m) => m[1]);
  return [
    "",
    "ВНИМАНИЕ: diff выше обрезан. Полный список изменённых файлов — открой и прочитай",
    "сам те, что не поместились (у тебя есть доступ на чтение к рабочему дереву):",
    ...files.map((f) => `- ${f}`),
  ];
}

export function buildReviewPrompt(task: TaskSpec, diffText: string): string {
  const criteria =
    task.acceptanceCriteria.length > 0
      ? task.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n")
      : "(не зафиксированы для этой задачи)";
  return [
    `Задача ${task.id}: ${task.title}`,
    "",
    task.description,
    "",
    "Критерии приёмки:",
    criteria,
    "",
    "Изменения (diff), уже прошедшие typecheck/lint/build/тесты:",
    "```diff",
    diffText.slice(0, MAX_REVIEW_DIFF_CHARS),
    "```",
    ...truncationNote(diffText),
    "",
    "Ты — независимый ревьюер. Найди то, что НЕ поймали автоматические проверки:",
    "архитектурные проблемы, уязвимости, граничные случаи без покрытия, нарушение",
    "конвенций проекта, нечитаемый или рискованный код. НЕ повторяй то, что уже",
    "гарантировано прошедшими тестами/типами/сборкой, и не придирайся к стилю,",
    "если он соответствует остальному проекту.",
    "",
    "Ответь СТРОГО в этом формате, на русском:",
    "",
    "БЛОКИРУЮЩИЕ:",
    "- <файл:строка — конкретная проблема и почему она блокирует>",
    "(если блокирующих проблем нет — напиши ровно НЕТ)",
    "",
    "ЗАМЕЧАНИЯ:",
    "- <файл:строка — на что стоит обратить внимание, не блокирует>",
    "(если замечаний нет — напиши ровно НЕТ)",
  ].join("\n");
}

const BLOCKING_HEADING = /блокирующие\s*:?/i;
const NONBLOCKING_HEADING = /замечания\s*:?/i;
const BULLET_LINE = /^[-*•]\s+(.+)$/gm;

// Whether the reviewer answered in the requested shape at all. parseReviewResponse
// returns [] both for "НЕТ / НЕТ" and for free-form text it couldn't parse — the
// caller has to tell those apart, or an unparseable answer reads as "approved".
export function isReviewResponseWellFormed(text: string): boolean {
  return text.search(BLOCKING_HEADING) !== -1;
}

export function parseReviewResponse(text: string): ReviewFinding[] {
  const blockIdx = text.search(BLOCKING_HEADING);
  const noteIdx = text.search(NONBLOCKING_HEADING);
  // Model didn't follow the format — fail open (no findings) rather than guessing at
  // structure that isn't there; a review that can't be parsed shouldn't silently block.
  if (blockIdx === -1 && noteIdx === -1) return [];

  const blockingEnd = noteIdx !== -1 && noteIdx > blockIdx ? noteIdx : undefined;
  const blockingSection = blockIdx !== -1 ? text.slice(blockIdx, blockingEnd) : "";
  const nonblockingSection = noteIdx !== -1 ? text.slice(noteIdx) : "";

  const blocking = [...blockingSection.matchAll(BULLET_LINE)].map((m) => ({ blocking: true, description: m[1].trim() }));
  const nonblocking = [...nonblockingSection.matchAll(BULLET_LINE)].map((m) => ({ blocking: false, description: m[1].trim() }));
  return [...blocking, ...nonblocking];
}

// What the developer turn sees when the reviewer found something blocking — same
// session (resumeSessionId), so it already remembers the whole task; this only needs
// to hand over what's new. Explicitly invites pushback rather than silent compliance —
// "не додумывай и не игнорируй" is a prompt-level nudge, not a mechanical guarantee,
// but asking the agent to say so when a finding looks wrong is strictly better than not
// asking at all.
export function buildReviewFixPrompt(blocking: ReviewFinding[]): string {
  return [
    "Независимый ревьюер проверил твои изменения и нашёл блокирующие проблемы.",
    "Исправь именно их, не трогая остальное без необходимости:",
    "",
    ...blocking.map((f, i) => `${i + 1}. ${f.description}`),
    "",
    "Если какое-то замечание кажется ошибочным или смысл неясен — прямо напиши об этом",
    "в ответе, а не игнорируй его молча и не додумывай за ревьюера.",
  ].join("\n");
}

// Audit-trail format for .harness-state/tasks/<id>/reviewer/round-N.md — reconstructs
// the review turn's own БЛОКИРУЮЩИЕ/ЗАМЕЧАНИЯ shape from the parsed findings, so a
// human reading the file back sees the same thing the model itself saw and responded
// to, round by round.
export function formatReviewRound(findings: ReviewFinding[], reason: string | undefined): string {
  if (reason) return `Ревью не удалось провести: ${reason}`;
  const blocking = findings.filter((f) => f.blocking);
  const nonblocking = findings.filter((f) => !f.blocking);
  return [
    "БЛОКИРУЮЩИЕ:",
    blocking.length > 0 ? blocking.map((f) => `- ${f.description}`).join("\n") : "НЕТ",
    "",
    "ЗАМЕЧАНИЯ:",
    nonblocking.length > 0 ? nonblocking.map((f) => `- ${f.description}`).join("\n") : "НЕТ",
  ].join("\n");
}

// Read-only, same shape as propose/acceptance: runs in the already-committed worktree
// (Edit/Write/Bash denied) so it can explore surrounding code for context, but can
// never itself change anything — a reviewer that edits the thing it's reviewing isn't
// independent.
export async function reviewChanges(
  worktreeDir: string,
  task: TaskSpec,
  opts: { model: string; baseBranch: string; maxBudgetUsd?: number },
): Promise<ReviewOutcome> {
  // Not caught: an unreadable diff is an infrastructure failure, and reviewing "" would
  // just produce a confident approval of nothing.
  const diffText = await getWorktreeDiff(worktreeDir, opts.baseBranch);
  if (!diffText.trim()) return { findings: [], costUsd: 0, reason: "diff пустой — ревьюить нечего" };

  // Fail CLOSED: a turn that errored (session limit, budget, crash) or answered in no
  // recognisable format used to come back as zero findings — i.e. "reviewer is happy" —
  // and the task went on to push unreviewed. One retry, then the caller escalates.
  let costUsd = 0;
  let reason = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const turn = await runClaudeTurn({
      cwd: worktreeDir,
      prompt: buildReviewPrompt(task, diffText),
      permissionMode: "acceptEdits",
      disallowedToolsOverride: "Bash,Edit,Write,MultiEdit",
      model: opts.model,
      maxBudgetUsd: opts.maxBudgetUsd,
    });
    costUsd += turn.totalCostUsd;
    if (turn.isError) {
      reason = `ход завершился ошибкой: ${turn.resultText.slice(0, 200)}`;
      continue;
    }
    if (!isReviewResponseWellFormed(turn.resultText)) {
      reason = "ответ ревьюера не в ожидаемом формате (нет раздела БЛОКИРУЮЩИЕ)";
      continue;
    }
    return { findings: parseReviewResponse(turn.resultText), costUsd };
  }
  return { findings: [], costUsd, reason };
}
