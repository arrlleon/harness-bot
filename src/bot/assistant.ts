import { tmpdir } from "node:os";
import { config } from "../config.js";
import { runClaudeTurn } from "../engine/claudeEngine.js";
import type { LiveState } from "./liveState.js";
import type { TaskRecord } from "./state.js";

// Free-text chat with the bot. The old classifier (no tools, no memory of the
// conversation) could only map a message onto a slash command — reproduced live
// (XEN-541): "то есть задача уже сделана на деве?", asked right under the bot's own
// "ПРОПУЩЕНО" message, got the generic /status block. This turn sees the recent chat,
// the bot's live state and history, can READ both repositories to answer a question
// about the code, and can ask the bot to run one of its own commands — including
// taking a ticket with the human's instruction attached.

export interface ChatEntry {
  from: "user" | "bot";
  text: string;
}

const CHAT_LOG_SIZE = 14;
const CHAT_ENTRY_CHARS = 1800;

export class ChatLog {
  private entries: ChatEntry[] = [];

  add(from: ChatEntry["from"], text: string): void {
    const clean = text.trim();
    if (!clean) return;
    this.entries.push({ from, text: clean.length > CHAT_ENTRY_CHARS ? clean.slice(0, CHAT_ENTRY_CHARS) + "…" : clean });
    if (this.entries.length > CHAT_LOG_SIZE) this.entries.splice(0, this.entries.length - CHAT_LOG_SIZE);
  }

  recent(): ChatEntry[] {
    return [...this.entries];
  }
}

// Ticket keys the conversation is about: named in the new message, else in the last few
// chat entries (a question right under the bot's own message about XEN-541 rarely
// repeats the key). Newest first, at most `max`.
export function ticketKeysIn(message: string, chat: ChatEntry[], max = 2): string[] {
  const found: string[] = [];
  const scan = (text: string): void => {
    for (const m of text.toUpperCase().matchAll(/\b[A-Z][A-Z0-9]+-\d+\b/g)) if (!found.includes(m[0])) found.push(m[0]);
  };
  scan(message);
  for (const entry of chat.slice(-3).reverse()) {
    if (found.length >= max) break;
    scan(entry.text);
  }
  return found.slice(0, max);
}

export type AssistantAction =
  | { type: "status" | "metrics" | "budget" | "list" | "peek" | "kill" | "stop" | "auto" | "help" }
  | { type: "retry"; key: string }
  // Analyse a ticket and send a proposal; `repo` forces where, `note` is the human's
  // instruction carried into the task.
  | { type: "propose"; key: string; repo?: "backend" | "frontend"; note?: string }
  // Take the proposal that is waiting for approval into work / drop it.
  | { type: "confirm" }
  | { type: "cancel" };

export interface AssistantReply {
  reply: string;
  action?: AssistantAction;
}

const ISSUE_KEY = /^[A-Z][A-Z0-9]*-\d+$/;
const SIMPLE = new Set(["status", "metrics", "budget", "list", "peek", "kill", "stop", "auto", "help", "confirm", "cancel"]);

// The answer is free text; a command, if any, is one last line "ДЕЙСТВИЕ: {json}".
// Anything malformed is dropped rather than guessed at: a wrong command is worse than
// none, and the text of the reply still reaches the human.
export function parseAssistantReply(raw: string): AssistantReply {
  const lines = raw.trim().split("\n");
  let action: AssistantAction | undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^\s*ДЕЙСТВИЕ\s*:\s*(\{.*\})\s*$/i.exec(lines[i]);
    if (!m) continue;
    lines.splice(i, 1);
    try {
      action = validateAction(JSON.parse(m[1]));
    } catch {
      action = undefined;
    }
    break;
  }
  return { reply: lines.join("\n").trim(), action };
}

function validateAction(value: unknown): AssistantAction | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  const type = String(v.type ?? "");
  if (SIMPLE.has(type)) return { type } as AssistantAction;
  const key = String(v.key ?? "").trim().toUpperCase();
  if (type === "retry" && ISSUE_KEY.test(key)) return { type: "retry", key };
  if (type === "propose" && ISSUE_KEY.test(key)) {
    const repo = v.repo === "backend" || v.repo === "frontend" ? v.repo : undefined;
    const note = typeof v.note === "string" && v.note.trim() ? v.note.trim().slice(0, 1500) : undefined;
    return { type: "propose", key, repo, note };
  }
  return undefined;
}

function describeState(live: LiveState): string {
  const lines: string[] = [];
  const job = live.currentJob;
  if (job) lines.push(`в работе: ${job.issueKey} «${job.title}», этап ${job.phase}, попытка ${job.iteration}/${job.maxIterations}, потрачено $${job.costUsd.toFixed(2)}`);
  if (live.analyzing) lines.push(`идёт анализ: ${live.analyzing}`);
  if (live.pendingApproval) lines.push(`ждёт твоего «взять в работу»: предложение по ${live.pendingApproval.issueKey} (${live.pendingApproval.repo})`);
  if (live.pendingHumanReview) lines.push(`ждёт твоего решения (остановка): ${live.pendingHumanReview.issueKey} — ${live.pendingHumanReview.reason.slice(0, 200)}`);
  if (live.pendingBrief) lines.push(`ждёт ответа на вопрос агента: ${live.pendingBrief.issueKey}`);
  return lines.length ? lines.join("\n") : "ничего не выполняется и ничего не ждёт решения";
}

export function buildAssistantPrompt(input: {
  message: string;
  chat: ChatEntry[];
  live: LiveState;
  history: TaskRecord[];
  repos: { backend?: string; frontend?: string };
  // The Jira tickets the conversation is about (see ticketKeysIn), so "is it done?"
  // can be checked against what the ticket actually asks for.
  tickets?: Array<{ key: string; summary: string; description: string }>;
}): string {
  const tickets = (input.tickets ?? [])
    .map((t) => `### ${t.key}: ${t.summary}\n${t.description.slice(0, 2500)}`)
    .join("\n\n");
  const history = input.history
    .slice(-6)
    .map((h) => `- ${h.timestamp.slice(0, 16)} ${h.issueKey}: ${h.outcome} — ${String(h.detail).slice(0, 160)}`)
    .join("\n");
  const chat = input.chat.map((e) => `${e.from === "user" ? "CEO" : "БОТ"}: ${e.text}`).join("\n\n");
  return [
    "Ты — «зам. CEO»: бот в Telegram, который берёт тикеты из Jira, сам пишет код через агента-",
    "разработчика, проверяет его тестами и независимым ревью и открывает MR в GitLab. С тобой пишет CEO.",
    "Отвечай ему по-русски, по делу, как коллега: коротко (обычно 2–6 предложений), простыми словами,",
    "без markdown-разметки. Он не программист — без путей к файлам и имён функций, если сам не спросил.",
    "",
    "Что ты можешь:",
    "1. Ответить на вопрос. Про то, что происходило в чате и с задачами, — по данным ниже. Про код",
    input.repos.backend || input.repos.frontend
      ? `   продукта — ПОСМОТРИ в репозитории (Read/Grep/Glob): бэкенд — текущая директория${input.repos.frontend ? `, фронтенд — ${input.repos.frontend}` : ""}.`
      : "   продукта — репозитории сейчас недоступны, так и скажи.",
    "   Прошлые сообщения бота — не доказательство. Если CEO спрашивает «это точно так?», «то есть уже",
    "   сделано?» — не пересказывай прошлый вывод, а ПРОВЕРЬ по коду сам: пройди по каждому пункту",
    "   тикета и скажи, что закрыто, что нет и при каком условии. Анализ бота мог ошибиться.",
    "   Не выдумывай: чего не знаешь и не можешь проверить — скажи прямо. Менять файлы ты не можешь.",
    "2. Выполнить команду бота. Тогда ПОСЛЕДНЕЙ строкой ответа напиши ровно:",
    '   ДЕЙСТВИЕ: {"type":"..."}',
    "   Доступные действия:",
    '   {"type":"status"} — что сейчас происходит;  {"type":"budget"} — расход за сегодня;',
    '   {"type":"metrics"} — статистика по задачам;  {"type":"list"} — показать список задач для выбора;',
    '   {"type":"peek"} — следующая задача в очереди;  {"type":"help"} — что бот умеет;',
    '   {"type":"kill"} — немедленно прервать текущую работу;  {"type":"stop"} — выключить автопоиск;',
    '   {"type":"auto"} — включить автопоиск задач;  {"type":"retry","key":"XEN-123"} — вернуть тикет в очередь;',
    '   {"type":"propose","key":"XEN-123","repo":"backend","note":"..."} — проанализировать тикет и прислать',
    "      предложение. repo (backend|frontend) указывай, только если CEO сам сказал, где делать, или если",
    "      анализ уже ответил «менять нечего», а CEO хочет делать всё равно. note — указание CEO своими",
    "      словами: что именно сделать или на что обратить внимание; оно пойдёт агенту вместе с тикетом.",
    '   {"type":"confirm"} — взять в работу предложение, которое ждёт подтверждения;',
    '   {"type":"cancel"} — не брать это предложение.',
    "   Одно действие за раз. Действие — только когда CEO явно просит что-то сделать; на вопрос просто",
    "   ответь. Если просьба неоднозначна (какой тикет? где делать?) — переспроси, а не угадывай.",
    "   Решения по остановившейся задаче (открыть MR, исправить самому, выбросить работу) принимаются",
    "   только кнопками под её сообщением — подскажи это, сам такое действие не выполняй.",
    "",
    "Текущее состояние бота:",
    describeState(input.live),
    "",
    "Последние задачи:",
    history || "(пока нет)",
    "",
    ...(tickets ? ["Тикеты, о которых идёт речь (текст из Jira):", tickets, ""] : []),
    "Последние сообщения в чате (сверху старые):",
    chat || "(пусто)",
    "",
    `Новое сообщение CEO: ${input.message}`,
  ].join("\n");
}

export async function askAssistant(input: Parameters<typeof buildAssistantPrompt>[0]): Promise<AssistantReply> {
  const cwd = input.repos.backend || input.repos.frontend || tmpdir();
  const turn = await runClaudeTurn({
    cwd,
    addDirs: input.repos.backend && input.repos.frontend ? [input.repos.frontend] : undefined,
    prompt: buildAssistantPrompt(input),
    permissionMode: "acceptEdits",
    // Read-only: it answers and asks the bot to act, it never touches a file itself.
    disallowedToolsOverride: "Bash,Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch,Task",
    model: config.models.assistant,
    maxBudgetUsd: config.assistantMaxBudgetUsd,
    // A chat reply isn't task work — /kill must not hit it (see processRegistry.ts).
    killable: false,
  });
  if (turn.isError && !turn.resultText.trim()) throw new Error("ассистент не ответил (лимит или сбой модели)");
  const parsed = parseAssistantReply(turn.resultText);
  return { ...parsed, reply: parsed.reply || (parsed.action ? "" : "Не понял, можешь переформулировать?") };
}
