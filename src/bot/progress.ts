import { tmpdir } from "node:os";
import { config } from "../config.js";
import { runClaudeTurn } from "../engine/claudeEngine.js";
import type { LiveJob } from "./liveState.js";
import { PHASE_RU, composeProgressText } from "./messages.js";

// A "what is it doing right now" line for the progress message, in the CEO's terms
// ("создаю эндпоинт для списка активных клиентов"), not the agent's ("Правка
// src/modules/admin/…/admin-active-clients.service.ts"). The agent's recent tool calls
// and notes are summarised by the cheap chat model; when that isn't possible the last
// file action is used as is.

const SUMMARY_LOG_LINES = 30;
// Phases where the agent itself is working and the log says something new. Everywhere
// else the phase label alone already says what is going on.
const AGENT_PHASES = new Set(["iterating", "writing_acceptance_test"]);

export function fallbackActivity(logs: string[]): string | null {
  for (let i = logs.length - 1; i >= 0; i--) {
    const m = /^→ (Правка|Запись|Чтение) (.+)$/.exec(logs[i]);
    if (!m) continue;
    const file = m[2].split("/").pop() ?? m[2];
    const verb = m[1] === "Чтение" ? "изучаю" : m[1] === "Запись" ? "создаю" : "правлю";
    return `${verb} ${file}`;
  }
  return null;
}

export function buildActivityPrompt(job: Pick<LiveJob, "title" | "phase">, logs: string[]): string {
  return [
    `Агент-разработчик работает над задачей «${job.title}». Ниже — его последние действия`,
    "(→ — вызов инструмента: чтение, правка или создание файла, поиск по коду; остальное — его заметки).",
    "",
    ...logs.slice(-SUMMARY_LOG_LINES),
    "",
    "Опиши одной короткой фразой по-русски, что он делает прямо сейчас — для руководителя,",
    "не для программиста: что именно строит или исправляет, а не какие файлы открывает.",
    "Начни с глагола в первом лице, 3–10 слов, без точки в конце, без кавычек, без пояснений.",
    "Примеры: «создаю эндпоинт для списка активных клиентов», «исправляю упавший тест проверки доступа».",
  ].join("\n");
}

export function cleanActivity(text: string): string | null {
  const line = text.trim().split("\n")[0]?.replace(/^[«"'\s]+|[»"'.\s]+$/g, "") ?? "";
  if (!line || line.length > 120) return null;
  return line.charAt(0).toLowerCase() + line.slice(1);
}

export async function describeActivity(job: LiveJob): Promise<string | null> {
  if (!AGENT_PHASES.has(job.phase) || job.logs.length === 0) return null;
  try {
    const turn = await runClaudeTurn({
      cwd: tmpdir(),
      prompt: buildActivityPrompt(job, job.logs),
      permissionMode: "acceptEdits",
      disallowedToolsOverride: "Bash,Edit,Write,MultiEdit,Read,Grep,Glob,WebFetch,WebSearch,NotebookEdit,Task",
      model: config.models.chat,
      // Not task work: /kill must not hit it, and it must not take /kill's reach away
      // from the real turn running at the same time (see processRegistry.ts).
      killable: false,
    });
    if (!turn.isError) {
      const summary = cleanActivity(turn.resultText);
      if (summary) return summary;
    }
  } catch {
    // The progress message must never be the thing that fails.
  }
  return fallbackActivity(job.logs);
}

export const PROGRESS_INTERVAL_MS = 5 * 60_000;

export interface ProgressMessenger {
  send(text: string): Promise<number | null>;
  edit(messageId: number, text: string): Promise<boolean>;
}

// One message per task, edited in place every PROGRESS_INTERVAL_MS (edits don't ping,
// so the chat isn't flooded); a fresh one is sent only when the task changes or the
// old one can no longer be edited.
export function startProgressReporter(getJob: () => LiveJob | null, messenger: ProgressMessenger): () => void {
  let messageFor: { issueKey: string; startedAt: string; messageId: number } | null = null;
  let busy = false;

  const tick = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      const job = getJob();
      if (!job) {
        messageFor = null;
        return;
      }
      const activity = await describeActivity(job);
      const current = getJob();
      // The task finished (or changed) while the summary was being written.
      if (!current || current.issueKey !== job.issueKey || current.startedAt !== job.startedAt) return;
      const text = composeProgressText({
        issueKey: current.issueKey,
        title: current.title,
        phaseLabel: PHASE_RU[current.phase] ?? current.phase,
        activity,
        iteration: current.iteration,
        maxIterations: current.maxIterations,
        costUsd: current.costUsd,
        budgetUsd: config.maxBudgetUsd,
        startedAt: current.startedAt,
        now: new Date(),
      });
      const sameJob = messageFor && messageFor.issueKey === current.issueKey && messageFor.startedAt === current.startedAt;
      if (sameJob && (await messenger.edit(messageFor!.messageId, text))) return;
      const id = await messenger.send(text);
      messageFor = id === null ? null : { issueKey: current.issueKey, startedAt: current.startedAt, messageId: id };
    } catch (err) {
      console.error("[bot] progress update failed:", (err as Error).message);
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(() => void tick(), PROGRESS_INTERVAL_MS);
  return () => clearInterval(timer);
}
