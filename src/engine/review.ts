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
    diffText.slice(0, 8000),
    "```",
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

// Read-only, same shape as propose/acceptance: runs in the already-committed worktree
// (Edit/Write/Bash denied) so it can explore surrounding code for context, but can
// never itself change anything — a reviewer that edits the thing it's reviewing isn't
// independent.
export async function reviewChanges(
  worktreeDir: string,
  task: TaskSpec,
  opts: { model: string; baseBranch: string },
): Promise<ReviewOutcome> {
  const diffText = await getWorktreeDiff(worktreeDir, opts.baseBranch).catch(() => "");

  const turn = await runClaudeTurn({
    cwd: worktreeDir,
    prompt: buildReviewPrompt(task, diffText),
    permissionMode: "acceptEdits",
    disallowedToolsOverride: "Bash,Edit,Write,MultiEdit",
    model: opts.model,
  });

  if (turn.isError) {
    return { findings: [], costUsd: turn.totalCostUsd, reason: `ход завершился ошибкой: ${turn.resultText.slice(0, 200)}` };
  }

  return { findings: parseReviewResponse(turn.resultText), costUsd: turn.totalCostUsd };
}
