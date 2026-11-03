import { runClaudeTurn } from "./claudeEngine.js";
import { getWorktreeDiff } from "./git.js";
import type { TaskSpec } from "../types.js";

export interface TestingNotesOutcome {
  // Undefined (not "") both when the turn errored and when it came back genuinely
  // empty — either way there's nothing worth putting in a Jira comment.
  notes?: string;
  costUsd: number;
  reason?: string;
}

// Same house format the team already uses for manual bug reports (Предусловия/Шаги/ОР)
// — a tester reading this comment shouldn't have to learn a new template. Explicitly
// told to write in terms of what a user clicks/sees, not the diff's files/functions —
// this is read-only context FOR someone who, unlike the independent reviewer, isn't
// expected to read code at all.
export function buildTestingNotesPrompt(task: TaskSpec, diffText: string): string {
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
    "Напиши инструкцию для тестировщика, который НЕ участвовал в разработке и не будет",
    "читать код — только пользуется приложением как обычный пользователь (или дёргает",
    "API напрямую, если задача бэкендовая). Пиши конкретно: реальные экраны, кнопки,",
    "поля, эндпоинты и их параметры — без ссылок на файлы, переменные или названия",
    "функций из диффа.",
    "",
    "Ответь СТРОГО в этом формате, на русском:",
    "",
    "ПРЕДУСЛОВИЯ:",
    "<что подготовить перед тестированием: роль пользователя, раздел/страница, тестовые данные>",
    "",
    "ШАГИ:",
    "1. <конкретный шаг>",
    "2. <ещё шаг>",
    "",
    "ОЖИДАЕМЫЙ РЕЗУЛЬТАТ:",
    "<что тестировщик должен увидеть, если задача сделана правильно>",
  ].join("\n");
}

// Read-only, same shape as the independent reviewer: runs in the already-committed
// worktree (Edit/Write/Bash denied) so it can explore surrounding code for context
// (e.g. to name the actual screen/route a change lives on), but never changes anything.
export async function generateTestingNotes(
  worktreeDir: string,
  task: TaskSpec,
  opts: { model: string; baseBranch: string },
): Promise<TestingNotesOutcome> {
  const diffText = await getWorktreeDiff(worktreeDir, opts.baseBranch).catch(() => "");

  const turn = await runClaudeTurn({
    cwd: worktreeDir,
    prompt: buildTestingNotesPrompt(task, diffText),
    permissionMode: "acceptEdits",
    disallowedToolsOverride: "Bash,Edit,Write,MultiEdit",
    model: opts.model,
  });

  if (turn.isError) {
    return { costUsd: turn.totalCostUsd, reason: `ход завершился ошибкой: ${turn.resultText.slice(0, 200)}` };
  }

  const notes = turn.resultText.trim();
  return { notes: notes.length > 0 ? notes : undefined, costUsd: turn.totalCostUsd };
}
