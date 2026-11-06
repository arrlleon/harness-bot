import { runClaudeTurn } from "./claudeEngine.js";
import { getWorktreeDiff } from "./git.js";
import type { TaskSpec } from "../types.js";

export interface CloseReportOutcome {
  // Undefined (not "") both when the turn errored and when it came back genuinely
  // empty — either way there's nothing worth sending in the closing Telegram message.
  report?: string;
  costUsd: number;
  reason?: string;
}

// Distinct from testingNotes (how to verify it works, for a tester) and project memory
// (durable facts, for a future agent session) — this is for the person who asked for
// the ticket in the first place and doesn't read diffs: what changed and why, in plain
// language, replacing the current bare "✅ closed, here's the MR link" with something
// that actually says what happened.
export function buildCloseReportPrompt(task: TaskSpec, diffText: string): string {
  return [
    `Задача ${task.id}: ${task.title}`,
    "",
    task.description,
    "",
    "Изменения (diff), уже прошедшие typecheck/lint/build/тесты и независимое ревью:",
    "```diff",
    diffText.slice(0, 8000),
    "```",
    "",
    "Напиши короткую сводку (2-4 предложения или несколько пунктов) для человека, который",
    "поставил эту задачу, но код не читает и в технических деталях не разбирается:",
    "какую проблему это решало и что изменилось для пользователей или для бизнеса.",
    "Простым языком, как объяснил бы коллеге без техфона. НЕ упоминай файлы, функции,",
    "классы, библиотеки, эндпоинты или другие технические термины из диффа.",
    "",
    "Ответь только текстом сводки, без заголовков, без markdown-разметки.",
  ].join("\n");
}

// Read-only, same shape as testingNotes/review: runs in the already-committed worktree
// (Edit/Write/Bash denied) so it can explore surrounding code for context, but never
// changes anything itself.
export async function generateCloseReport(
  worktreeDir: string,
  task: TaskSpec,
  opts: { model: string; baseBranch: string },
): Promise<CloseReportOutcome> {
  const diffText = await getWorktreeDiff(worktreeDir, opts.baseBranch).catch(() => "");

  const turn = await runClaudeTurn({
    cwd: worktreeDir,
    prompt: buildCloseReportPrompt(task, diffText),
    permissionMode: "acceptEdits",
    disallowedToolsOverride: "Bash,Edit,Write,MultiEdit",
    model: opts.model,
  });

  if (turn.isError) {
    return { costUsd: turn.totalCostUsd, reason: `ход завершился ошибкой: ${turn.resultText.slice(0, 200)}` };
  }

  const report = turn.resultText.trim();
  return { report: report.length > 0 ? report : undefined, costUsd: turn.totalCostUsd };
}
