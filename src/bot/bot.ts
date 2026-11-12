import { Bot, InlineKeyboard, type Context } from "grammy";
import { config } from "../config.js";
import {
  loadState,
  saveState,
  recordTask,
  recordOutcome,
  totalCostUsd,
  costSince,
  countSince,
  startOfTodayIso,
  computeMetrics,
  autoPollActive,
  type BotState,
} from "./state.js";
import { setBotRunning, getLiveState, loadPersistedPending } from "./liveState.js";
import { acquireBotLock } from "./lock.js";
import { tmpdir } from "node:os";
import { recoverOrphanedCheckpoints } from "../engine/checkpoint.js";
import { startDashboardServer, dashboardUrl } from "../web/server.js";
import {
  peekNext,
  retryIssue,
  confirmPending,
  cancelPending,
  listMenuCandidates,
  proposeNext,
  proposeIssueByKey,
  getPendingHumanReviewDiff,
  resolveHumanReview,
  continueNeedsHuman,
  resolveBrief,
  type Proposal,
  type Candidate,
} from "../queue.js";
import { killCurrentTurn, runClaudeTurn } from "../engine/claudeEngine.js";
import type { QueueRunOutcome, Brief } from "../types.js";

const REPO_RU: Record<string, string> = { backend: "бэкенд", frontend: "фронтенд", cross: "кросс-репо (бэкенд → фронтенд)" };

function statusTag(status: string | undefined): string {
  if (status === config.jira.inProgressStatus) return "[IN WORK]";
  if (status === config.jira.todoStatus) return "[TO DO]";
  return "[?]"; // shouldn't happen — listMenuCandidates already filters to these two
}

// Everything user-facing in this file speaks as one persona — "Зам. CEO" — not as a
// bare command dispatcher. The user explicitly wants this bot to feel like talking to
// someone who's actually handling the tickets, not reading machine log lines; the
// underlying data (cost, plans, diffs) is never invented or reworded, only the framing
// around it is. See classifyMessage below for the free-text half of this.
const HELP_TEXT = [
  "Я — твой зам. CEO по тикетам из Jira: слежу за очередью, читаю задачу и предлагаю решение, а как только одобришь — довожу до MR и держу в курсе на каждом шаге.",
  "",
  "/start — покажу список твоих задач («Сделать» + «В работе») с кнопками и жду, пока выберешь; сам ничего не беру",
  "/auto — автопоиск: сам беру верхнюю задачу из очереди на анализ и присылаю предложение (в работу — только после твоего подтверждения)",
  "/stop — выключу автопоиск и деактивирую кнопки в уже показанных списках (то, что уже в работе или ждёт твоего решения, не трогаю)",
  "/kill — немедленно прерву текущий ход (если завис или делает не то)",
  "/status — расскажу, что сейчас происходит, расход, последний обработанный тикет",
  "/metrics — исторический трек-рекорд: доля задач без эскалации, средние стоимость/время/раунды ревью",
  "/budget — расход/число задач за сегодня относительно дневных лимитов",
  "/peek — покажу следующий тикет в очереди, не запуская его",
  "/retry XEN-123 — верну тикет, застрявший в «нужен человек», обратно в очередь",
  "«нужен человек» — сразу присылаю diff с кнопками ✅ Принять/❌ Отклонить: можно запушить уже сделанную работу вручную, даже если сам я сдался",
  "брифы — если разработчику что-то реально неясно, не додумывает: присылаю вопрос с вариантами, выбираешь кнопкой, он продолжает с тем же контекстом",
  "/dashboard — ссылка на живой локальный дашборд",
  "/help — это сообщение",
  "",
  "Можешь просто написать мне, без команды — отвечу или сделаю то, что просишь, если это похоже на одну из команд выше.",
].join("\n");

function describeOutcome(outcome: QueueRunOutcome | { kind: "error"; message: string }): string | null {
  switch (outcome.kind) {
    case "empty":
      return null;
    case "paused":
      return `⏸ Приостановился: ${outcome.reason}`;
    case "busy":
      return null;
    case "brief_pending":
      // Handled separately (sendBrief, with option buttons) — never through this
      // plain-text path.
      return null;
    case "skipped":
      return `⏭ Пропустил ${outcome.issueKey} (${outcome.reason})`;
    case "needs_human":
      return `⚠️ Застрял на ${outcome.issueKey} (${outcome.reason}), потратил $${outcome.costUsd.toFixed(4)} — нужно твоё решение`;
    case "closed": {
      const reportLine = outcome.report ? `\n\n${outcome.report}` : "";
      return `✅ Готово: ${outcome.issueKey} закрыт, MR — ${outcome.mrUrl} (потратил $${outcome.costUsd.toFixed(4)})${reportLine}`;
    }
    case "error":
      return `❌ Не получилось: ${outcome.message}`;
  }
}

// MarkdownV2's reserved set (Telegram Bot API docs) — any of these appearing as literal
// text, not as formatting we deliberately wrote, must be backslash-escaped or the whole
// message is rejected outright. Jira text routinely contains most of these (code in
// backticks, parenthesized asides, "a.b.c" paths, "foo-bar" identifiers), so this has to
// run over every piece of dynamic text before it goes anywhere near our own `*`/`>`/`||`.
export function escapeMarkdownV2(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (ch) => `\\${ch}`);
}

// Telegram's expandable blockquote: first line starts with "**>", every line starts
// with ">", and the LAST line ends with "||" (no space before it) — that trailing
// marker is what makes it collapsed-by-default instead of a plain always-open quote.
function expandableBlockquote(lines: string[]): string {
  const body = lines.length > 0 ? lines : ["​"];
  return body.map((line, i) => (i === 0 ? "**>" : ">") + line + (i === body.length - 1 ? "||" : "")).join("\n");
}

// Short header stays plain and always visible; the description/plan (routinely long
// enough to bury the header below the fold — the actual complaint) collapse into one
// tap-to-expand block instead of dumping both inline every time.
function formatCostEstimate(estimate: Proposal["costEstimate"]): string {
  if (!estimate) return "📊 оценка: недостаточно истории для прогноза";
  // The leading "~" here is a literal approx sign, not MarkdownV2 syntax — but it's
  // also MarkdownV2's strikethrough delimiter, so an unescaped one left Telegram
  // waiting for a closing "~" that never came and rejected the whole message
  // ("can't find end of Strikethrough entity"). Must be escaped outside
  // escapeMarkdownV2's call (that only covers the cost/duration number themselves).
  const cost = `\\~$${escapeMarkdownV2(estimate.medianCostUsd.toFixed(2))}`;
  const duration =
    estimate.medianDurationMs !== null
      ? `, \\~${escapeMarkdownV2(Math.round(estimate.medianDurationMs / 60_000).toString())} мин`
      : "";
  return `📊 по истории \\(${estimate.sampleSize} задач\\): обычно ${cost}${duration}`;
}

export function formatProposal(p: Proposal): string {
  const header = [
    "Смотрю задачу — вот что предлагаю:",
    "",
    `🆕 *${escapeMarkdownV2(p.issueKey)}*: ${escapeMarkdownV2(p.title)}`,
    `📦 репозиторий: ${escapeMarkdownV2(REPO_RU[p.repo] ?? p.repo)}`,
    // toFixed's decimal point is itself a reserved MarkdownV2 character — reproduced
    // live ("Character '.' is reserved"), easy to miss since it looks like plain text.
    `💸 анализ стоил $${escapeMarkdownV2(p.costUsd.toFixed(4))}`,
    formatCostEstimate(p.costEstimate),
  ].join("\n");

  // Shown here so approval is a real review of the contract, not a rubber stamp on
  // the plan alone — these criteria are what actually gets frozen into the task once
  // you tap Подтвердить (see PendingApproval.acceptanceCriteria).
  const criteriaLines =
    p.acceptanceCriteria.length > 0
      ? p.acceptanceCriteria.map((c) => `• ${escapeMarkdownV2(c)}`)
      : ["\\(модель не сформулировала критерии — будет зафиксирован только план\\)"];

  const bodyLines = [
    "📋 Описание:",
    ...escapeMarkdownV2(p.descriptionShort || "(нет описания)").split("\n"),
    "",
    "💡 Предлагаемое решение:",
    ...escapeMarkdownV2(p.plan || "(нет плана)").split("\n"),
    "",
    "✅ Критерии приёмки \\(зафиксируются при подтверждении\\):",
    ...criteriaLines,
  ];

  return [header, "", expandableBlockquote(bodyLines)].join("\n");
}

// formatProposal, shrunk until it fits: a long plan plus seven criteria, once every
// reserved character is escaped, goes past Telegram's limit — and a proposal that
// can't be delivered still holds the queue (pendingApproval is set) with nothing in
// the chat to approve.
export function formatProposalFitted(p: Proposal): string {
  let candidate = p;
  for (let budget = 1800; budget >= 200; budget -= 400) {
    const text = formatProposal(candidate);
    if (text.length <= TELEGRAM_SAFE_CHARS) return text;
    const clip = (t: string): string => (t.length > budget ? t.slice(0, budget) + "…" : t);
    candidate = { ...p, plan: clip(p.plan), acceptanceCriteria: p.acceptanceCriteria.map((c) => clip(c).slice(0, Math.max(120, Math.floor(budget / 4)))) };
  }
  return formatProposal(candidate).slice(0, TELEGRAM_SAFE_CHARS);
}

// Modeled on ETS Tender's own production "брифы": a structured question with concrete
// options the human answers with one click, not free text the harness would have to
// interpret. ★ marks the agent's own recommendation, same as their deck shows it.
function formatBrief(issueKey: string, brief: Brief, crossRepoStage?: "backend" | "frontend"): string {
  const stageTag = crossRepoStage === "backend" ? " (бэкенд-часть)" : crossRepoStage === "frontend" ? " (фронтенд-часть)" : "";
  const lines = [
    `❓ Вопрос по ${issueKey}${stageTag}:`,
    brief.question,
    "",
    ...brief.options.map((o, i) => `${i + 1}. ${o.label}${brief.recommendedIndex === i ? " ★" : ""}`),
  ];
  if (brief.rationale) lines.push("", `Почему так: ${brief.rationale}`);
  return lines.join("\n");
}

function briefKeyboard(issueKey: string, brief: Brief): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  brief.options.forEach((o, i) => {
    const label = brief.recommendedIndex === i ? `★ ${i + 1}. ${o.label}` : `${i + 1}. ${o.label}`;
    keyboard.text(label.slice(0, 64), `brief_answer:${issueKey}:${i}`).row();
  });
  return keyboard;
}

// Telegram rejects a message over 4096 characters outright — and a rejected message
// takes its buttons with it. Everything the bot sends goes through this first.
const TELEGRAM_SAFE_CHARS = 4000;

export function fitTelegram(text: string, limit = TELEGRAM_SAFE_CHARS): string {
  const marker = "\n… (обрезано)";
  return text.length <= limit ? text : text.slice(0, limit - marker.length) + marker;
}

// Undoes escapeMarkdownV2 and the blockquote markers — the plain-text fallback for a
// proposal Telegram refused to parse.
export function plainFromMarkdownV2(text: string): string {
  return text
    .replace(/^\*\*>/gm, "")
    .replace(/^>/gm, "")
    .replace(/\|\|$/gm, "")
    .replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1");
}

const MAX_REASON_CHARS = 700;

// Header first, then as much of the diff as still fits. The reason alone can run to a
// thousand characters (an agent_error's own text, a rebase conflict) or be unbounded
// (review findings) — with a fixed 3200-character diff on top, the message went over
// Telegram's limit and never arrived, buttons included.
export function composeNeedsHumanText(outcome: { issueKey: string; reason: string; costUsd: number }, diff: string | null): string {
  const reason = outcome.reason.length > MAX_REASON_CHARS ? outcome.reason.slice(0, MAX_REASON_CHARS) + "…" : outcome.reason;
  const header = `⚠️ Застрял на ${outcome.issueKey} (${reason}), потратил $${outcome.costUsd.toFixed(4)} — нужно твоё решение.`;
  if (diff === null) return header;
  if (!diff.trim()) return `${header}\n\n(diff пустой — похоже, ничего не изменил)`;
  const room = TELEGRAM_SAFE_CHARS - header.length - 60;
  const body = diff.length > room ? diff.slice(0, Math.max(0, room)) + "\n… (обрезано, полный diff в worktree)" : diff;
  return `${header}\n\n${body}`;
}

// needs_human doesn't mean the work is wrong — XEN-364 reproduced a case where a fully
// correct fix just burned through max_iterations on a harness bug, not a bad fix. Rather
// than silently leaving it in the worktree with just a one-line Jira comment, show the
// actual diff and let a human decide instead of discarding real (possibly good) work.
type Sender = (text: string, keyboard?: InlineKeyboard) => Promise<unknown>;

async function sendNeedsHumanReview(
  send: Sender,
  outcome: { issueKey: string; reason: string; costUsd: number },
): Promise<void> {
  let diff: string | null = null;
  let diffError = "";
  try {
    diff = await getPendingHumanReviewDiff();
  } catch (err) {
    diffError = `\nНе удалось прочитать diff: ${(err as Error).message.slice(0, 200)}`;
  }
  // No review on record any more (resolved in the meantime) — just say what happened.
  if (!getLiveState().pendingHumanReview) {
    await send(composeNeedsHumanText(outcome, null));
    return;
  }
  const text = composeNeedsHumanText(outcome, diff) + diffError;
  const keyboard = new InlineKeyboard()
    .text("✅ Принять и запушить", `accept_human:${outcome.issueKey}`)
    .text("❌ Отклонить", `reject_human:${outcome.issueKey}`);
  // Present for context_budget and agent_error (single-repo — see queue.ts's two
  // commented-out cross-repo resumeState assignments for why cross-repo doesn't get
  // this button); every other needs_human reason has no resumeState and never shows
  // this third button at all. The label matters: context_budget's resumeState is
  // freshSession (that session's own size was the problem — see CloseLoopResumeState's
  // comment), so clicking it is explicitly accepting a known tradeoff, no memory of
  // what the stopped session already tried. agent_error instead resumes the exact
  // same session via --resume (the paused turn's own reasoning, unaffected by whatever
  // actually caused it — an account limit, a budget cutoff — is exactly what's wanted).
  const resumeState = getLiveState().pendingHumanReview?.resumeState;
  if (resumeState) {
    const label = resumeState.freshSession ? "🔄 Продолжить (новая сессия)" : "🔄 Продолжить";
    keyboard.row().text(label, `continue_human:${outcome.issueKey}`);
  }
  await send(text, keyboard);
}

export async function startBot(): Promise<void> {
  if (!config.telegram.botToken) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  if (config.telegram.allowedChatIds.length === 0) {
    throw new Error("TELEGRAM_ALLOWED_CHAT_IDS is not set — refusing to start an open bot");
  }

  acquireBotLock();
  const bot = new Bot(config.telegram.botToken);
  const state: BotState = loadState();
  // A crash or hard kill can leave `running: true` on disk with nothing actually
  // polling; on a fresh process start no loop can possibly be alive yet, so the
  // persisted flag would otherwise lie to /status until the next /start or /stop.
  state.running = false;
  state.autoPoll = false;
  saveState(state);
  setBotRunning(false);

  const announceChatId = config.telegram.allowedChatIds[0];

  // Never throws, and degrades rather than drops: full text → trimmed plain text → a
  // one-line pointer to /status, each still carrying the buttons. Outcome messages are
  // the only way a human learns a task needs them; one that fails to send used to fail
  // in silence (a swallowed .catch), leaving the task waiting on nobody.
  async function sendSafe(chatId: number | string, text: string, keyboard?: InlineKeyboard, parseMode?: "MarkdownV2"): Promise<void> {
    const markup = keyboard ? { reply_markup: keyboard } : {};
    try {
      await bot.api.sendMessage(chatId, parseMode ? text : fitTelegram(text), parseMode ? { ...markup, parse_mode: parseMode } : markup);
      return;
    } catch (err) {
      console.error("[bot] send failed, retrying as plain text:", (err as Error).message);
    }
    try {
      await bot.api.sendMessage(chatId, fitTelegram(parseMode ? plainFromMarkdownV2(text) : text, 3500), markup);
      return;
    } catch (err) {
      console.error("[bot] plain-text send failed too:", (err as Error).message);
    }
    await bot.api
      .sendMessage(chatId, "⚠️ Не смог отправить сообщение целиком — подробности в /status.", markup)
      .catch((err) => console.error("[bot] could not deliver anything:", (err as Error).message));
  }
  const senderFor = (chatId: number | string): Sender => (text, keyboard) => sendSafe(chatId, text, keyboard);
  const announce: Sender = senderFor(announceChatId);

  // Shared by the startup restore below and the auto-poll loop further down — a found
  // proposal is announced the same way (same buttons, same MarkdownV2 formatting)
  // whichever path found it.
  async function announceProposal(p: Proposal, prefix = ""): Promise<void> {
    const keyboard = new InlineKeyboard().text("✅ Подтвердить", `confirm:${p.issueKey}`).text("❌ Отменить", `cancel:${p.issueKey}`);
    // formatProposal's output is MarkdownV2 (the expandable blockquote) — unlike the
    // plain-text `announce` used for needs_human, this one needs parse_mode set.
    await sendSafe(announceChatId, escapeMarkdownV2(prefix) + formatProposalFitted(p), keyboard, "MarkdownV2");
  }

  // The in-process replacement for cron `queue`: as long as state.running, this keeps
  // calling proposeNext() itself on a timer — the exact same propose-not-dispatch path a
  // manual /start pick goes through, just triggered by a clock instead of a button. Polls
  // fast (activePollSeconds) right after skipping a ticket (more may be queued right
  // behind it), backs off to idlePollSeconds once nothing's left to find or the single
  // task slot is already occupied (an approval/review/brief with its own buttons) — no
  // point hammering Jira while blocked on a human decision. Reproduced live as the gap
  // this whole fix closes: `queue` on cron (and the dashboard's old "start" button) used
  // to skip straight to dispatchIssue() with no human ever seeing a plan first — see
  // queue.ts's runQueueOnce/dispatchIssue comments.
  let pollTimer: ReturnType<typeof setTimeout> | null = null;

  function clearPoll(): void {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  function schedulePoll(delaySeconds: number): void {
    clearPoll();
    if (!autoPollActive(state)) return;
    pollTimer = setTimeout(() => void pollOnce(), delaySeconds * 1000);
  }

  async function pollOnce(): Promise<void> {
    if (!autoPollActive(state)) return;
    try {
      const outcome = await proposeNext();
      switch (outcome.kind) {
        case "proposed":
          await announceProposal(outcome.proposal);
          schedulePoll(config.telegram.idlePollSeconds);
          break;
        case "skipped":
          schedulePoll(config.telegram.activePollSeconds);
          break;
        default:
          // empty / busy / awaiting_approval / paused — nothing more to do right now.
          schedulePoll(config.telegram.idlePollSeconds);
      }
    } catch (err) {
      console.error("[bot] auto-poll failed:", (err as Error).message);
      schedulePoll(config.telegram.idlePollSeconds);
    }
  }

  startDashboardServer(config.dashboard.port, (p) => void announceProposal(p), (text) => void announce(text), config.dashboard.host);

  // A restart loses nothing mid-decision: a pending proposal or needs_human review has
  // no running process behind it (that already finished) — only the bot's own memory of
  // it, which loadPersistedPending() just restored from disk. Re-announce it so it isn't
  // silently sitting there until someone happens to check /status.
  const restored = loadPersistedPending();
  if (restored.pendingApproval) {
    void announceProposal(restored.pendingApproval, "🔄 Восстановлено после перезапуска:\n\n");
  }
  if (restored.pendingHumanReview) {
    const p = restored.pendingHumanReview;
    void sendNeedsHumanReview(
      (text, keyboard) => announce("🔄 Восстановлено после перезапуска:\n\n" + text, keyboard),
      { issueKey: p.issueKey, reason: p.reason, costUsd: p.costUsd },
    );
  }
  if (restored.pendingBrief) {
    const p = restored.pendingBrief;
    void announce("🔄 Восстановлено после перезапуска:\n\n" + formatBrief(p.issueKey, p.brief, p.crossRepo?.stage), briefKeyboard(p.issueKey, p.brief));
  }

  // A checkpoint left on disk means the process died mid-iteration last run (not a
  // clean needs_human stop — those are already covered by restored.pendingHumanReview
  // above). The worktree's uncommitted work is still sitting right where the agent
  // left it; surface it the same way so nothing from a crash is ever just silently lost.
  // Called again after every resolved review: there is one review slot, so a second
  // interrupted task waits on disk until the first is decided.
  function announceRecoveredCheckpoints(): void {
    for (const { checkpoint, reason } of recoverOrphanedCheckpoints()) {
      void sendNeedsHumanReview(
        (text, keyboard) => announce("⚠️ Найдена прерванная перезапуском задача:\n\n" + text, keyboard),
        { issueKey: checkpoint.issueKey, reason, costUsd: checkpoint.costUsd },
      );
    }
  }
  announceRecoveredCheckpoints();

  bot.use(async (ctx, next) => {
    const chatId = String(ctx.chat?.id ?? "");
    if (!config.telegram.allowedChatIds.includes(chatId)) {
      console.warn(`[bot] rejected message from unauthorized chat ${chatId}`);
      return;
    }
    await next();
  });

  function menuLine(c: Candidate): string {
    return `${statusTag(c.issue.status)} ${c.issue.key}: ${c.issue.summary}`;
  }

  // /start no longer auto-picks a ticket — it lists what's assigned to you
  // (To Do + In Progress) and waits for a `pick:` button click to analyze a
  // specific one. Nothing is proposed or executed without that explicit pick.
  // Also reused as the auto-follow-up after a task closes (see confirm/accept_human/
  // reject_human below) so the queue keeps moving without a manual /start each time.
  //
  // `resume: true` means an explicit user action (/start, or "show me the list" free
  // text) — always (re)enables state.running, same as before. Omitted means this is an
  // AUTO follow-up after a task just finished: only show the menu (and keep the auto-
  // poll loop going, since it reads state.running too) if the user hasn't pressed
  // /stop while that task was running — otherwise /stop would be silently undone the
  // moment the in-flight task happened to finish. Reproduced live: before this, /stop
  // mid-task had no lasting effect at all once that task closed.
  async function sendTicketMenu(ctx: Context, intro = "Выбери задачу, которую взять в работу:", opts: { resume?: boolean } = {}): Promise<void> {
    if (opts.resume) {
      // Menus only. Picking tickets by itself is /auto's job — see BotState.autoPoll.
      state.running = true;
      saveState(state);
    } else if (!state.running) {
      return;
    }
    try {
      const candidates = await listMenuCandidates();
      if (candidates.length === 0) {
        await ctx.reply("Нет задач в «Сделать» или «В работе», назначенных на тебя.");
        return;
      }
      const keyboard = new InlineKeyboard();
      for (const c of candidates) {
        keyboard.text(menuLine(c).slice(0, 64), `pick:${c.issue.key}`).row();
      }
      await ctx.reply(intro, { reply_markup: keyboard });
    } catch (err) {
      await ctx.reply(`❌ Не удалось получить список задач: ${(err as Error).message}`);
    }
  }

  bot.command("start", (ctx) => sendTicketMenu(ctx, undefined, { resume: true }));

  async function handleAuto(ctx: Context): Promise<void> {
    state.running = true;
    state.autoPoll = true;
    saveState(state);
    schedulePoll(config.telegram.activePollSeconds);
    await ctx.reply("🔁 Автопоиск включён: сам беру верхнюю задачу из очереди на анализ и присылаю предложение. В работу без твоего подтверждения ничего не идёт. Выключить — /stop.");
  }
  bot.command("auto", handleAuto);

  bot.callbackQuery(/^pick:(.+)$/, async (ctx) => {
    const key = ctx.match[1];
    if (!state.running) {
      await ctx.answerCallbackQuery({ text: "Список уже неактуален — нажми /start заново.", show_alert: true });
      return;
    }
    if (getLiveState().pendingApproval) {
      await ctx.answerCallbackQuery({ text: "Сначала подтверди или отмени предыдущее предложение.", show_alert: true });
      return;
    }
    const pendingReview = getLiveState().pendingHumanReview;
    if (pendingReview) {
      // Confirming here would re-run createWorktree, which force-removes the existing
      // worktree first — for the SAME ticket that would destroy the diff this review
      // is waiting on. Any other ticket is unaffected, but the simplest safe rule is
      // "resolve what's pending before picking anything else."
      await ctx.answerCallbackQuery({
        text: `Сначала прими или отклони ${pendingReview.issueKey} (ждёт решения выше).`,
        show_alert: true,
      });
      return;
    }
    if (getLiveState().currentJob) {
      await ctx.answerCallbackQuery({ text: "Сейчас уже выполняется другая задача.", show_alert: true });
      return;
    }
    // Reproduced live (2026-11-10): without this check, picking while an earlier pick's
    // analysis is still in flight fell through to the "Анализирую…" placeholder below,
    // which then got edited into a generic "не удалось начать" once proposeIssueByKey's
    // own busy guard caught it — reading as a failure worth retrying, not "already
    // running, just wait". Checking `analyzing` here answers immediately, by name,
    // before that placeholder ever shows.
    const alreadyAnalyzing = getLiveState().analyzing;
    if (alreadyAnalyzing && alreadyAnalyzing !== "searching") {
      await ctx.answerCallbackQuery({
        text: `${alreadyAnalyzing} уже анализируется — подожди, это недолго.`,
        show_alert: true,
      });
      return;
    }
    await ctx.answerCallbackQuery({ text: "Анализирую…" });

    // Reproduced live: a multi-minute silent gap while Claude reads a real codebase
    // reads as "it's stuck", not "it's thinking" — say so up front, then edit this
    // same message into the finished proposal below.
    const msg = await ctx.reply(`🔎 Анализирую ${key}, подбираю решение… ⏳`);
    try {
      const outcome = await proposeIssueByKey(key);
      if (outcome.kind === "proposed") {
        const keyboard = new InlineKeyboard()
          .text("✅ Подтвердить", `confirm:${outcome.proposal.issueKey}`)
          .text("❌ Отменить", `cancel:${outcome.proposal.issueKey}`);
        const text = formatProposalFitted(outcome.proposal);
        const editedOk = await ctx.api
          .editMessageText(ctx.chat!.id, msg.message_id, text, { reply_markup: keyboard, parse_mode: "MarkdownV2" })
          .then(() => true)
          .catch(() => false);
        if (!editedOk) await sendSafe(ctx.chat!.id, text, keyboard, "MarkdownV2");
      } else if (outcome.kind === "skipped") {
        await ctx.api
          .editMessageText(ctx.chat!.id, msg.message_id, `⏭️ ${outcome.issueKey}: пропущен (${outcome.reason})`)
          .catch(() => ctx.reply(`⏭️ ${outcome.issueKey}: пропущен (${outcome.reason})`));
      } else if (outcome.kind === "paused") {
        await ctx.api
          .editMessageText(ctx.chat!.id, msg.message_id, `⏸ Пауза: ${outcome.reason}`)
          .catch(() => ctx.reply(`⏸ Пауза: ${outcome.reason}`));
      } else {
        // awaiting_approval / busy: a narrow residual race between the guards above
        // and proposeIssueByKey's own internal check (there's an `await` in between —
        // answerCallbackQuery — so it's not fully closed). Name what's actually busy
        // when we know it, instead of a generic "failed, try again".
        const busyText =
          outcome.kind === "busy" && outcome.busyWith
            ? `${outcome.busyWith} уже обрабатывается — подожди, это недолго.`
            : "Уже занято другой задачей — подожди, это недолго.";
        await ctx.api.editMessageText(ctx.chat!.id, msg.message_id, busyText).catch(() => {});
      }
    } catch (err) {
      await ctx.api
        .editMessageText(ctx.chat!.id, msg.message_id, `❌ Ошибка: ${(err as Error).message}`)
        .catch(() => ctx.reply(`❌ Ошибка: ${(err as Error).message}`));
    }
  });

  async function handleStop(ctx: Context): Promise<void> {
    state.running = false;
    state.autoPoll = false;
    saveState(state);
    clearPoll();
    await ctx.reply("🛑 Понял. Кнопки в уже показанных списках задач больше не сработают — напиши /start заново, когда понадобится.");
  }
  bot.command("stop", handleStop);

  async function handleKill(ctx: Context): Promise<void> {
    state.running = false;
    state.autoPoll = false;
    saveState(state);
    clearPoll();
    const killed = killCurrentTurn();
    await ctx.reply(killed ? "⛔ Прервал текущий ход. Поиск новых тикетов тоже останавливаю." : "🤷 Сейчас ничего не делаю. Останавливаю поиск новых тикетов.");
  }
  bot.command("kill", handleKill);

  async function handleBudget(ctx: Context): Promise<void> {
    const todayIso = startOfTodayIso();
    const spent = costSince(state, todayIso);
    const tasks = countSince(state, todayIso);
    const lines = [
      "💰 Бюджет",
      `потратил сегодня: $${spent.toFixed(4)} / $${config.dailyBudgetUsd}`,
      `задач сегодня: ${tasks} / ${config.maxTasksPerDay}`,
      `лимит на задачу: $${config.maxBudgetUsd}, ${config.maxIterations} итераций`,
    ];
    await ctx.reply(lines.join("\n"));
  }
  bot.command("budget", handleBudget);

  async function handlePeek(ctx: Context): Promise<void> {
    try {
      const candidate = await peekNext();
      if (!candidate) {
        await ctx.reply("Очередь пуста.");
        return;
      }
      const { issue, detection } = candidate;
      const repoLine =
        detection.kind === "backend" || detection.kind === "frontend"
          ? `тег: ${REPO_RU[detection.kind]} (подсказка; репозитории определю по коду при анализе)`
          : detection.kind === "ambiguous"
            ? `тег: ${REPO_RU.cross} (подсказка; репозитории определю по коду при анализе)`
            : "репозиторий: без тега — определю по коду при анализе";
      await ctx.reply(
        [`${issue.key}: ${issue.summary}`, repoLine, "", issue.description.slice(0, 1000)].join("\n"),
      );
    } catch (err) {
      await ctx.reply(`Ошибка: ${(err as Error).message}`);
    }
  }
  bot.command("peek", handlePeek);

  async function handleRetry(ctx: Context, key: string | undefined): Promise<void> {
    if (!key) {
      await ctx.reply("Использование: /retry XEN-123");
      return;
    }
    try {
      await retryIssue(key);
      await ctx.reply(`${key} возвращён в очередь.`);
    } catch (err) {
      await ctx.reply(`Не удалось вернуть ${key}: ${(err as Error).message}`);
    }
  }
  bot.command("retry", (ctx) => handleRetry(ctx, ctx.match?.toString().trim().toUpperCase() || undefined));

  async function handleHelp(ctx: Context): Promise<void> {
    await ctx.reply(HELP_TEXT);
  }
  bot.command("help", handleHelp);

  bot.command("dashboard", async (ctx) => {
    // Telegram rejects localhost in inline-button URLs ("Wrong HTTP URL") since its
    // servers can't resolve it — plain text is the only option for a local dashboard.
    await ctx.reply(`Живой статус процессов и задач: ${dashboardUrl(config.dashboard.port)}`);
  });

  async function handleStatus(ctx: Context): Promise<void> {
    const last = state.history.at(-1);
    const live = getLiveState();
    const waitingOn = live.pendingApproval?.issueKey ?? live.pendingHumanReview?.issueKey ?? live.pendingBrief?.issueKey;
    // What's actually happening comes first. This used to report only the auto-poll
    // flag ("не запущен") and what was waiting on a human — so mid-task it answered
    // "ничего не жду" with no mention that a task was running at all.
    const job = live.currentJob;
    const doing = job
      ? `🛠 в работе: ${job.issueKey} — фаза ${job.phase}, итерация ${job.iteration}/${job.maxIterations}, потрачено $${job.costUsd.toFixed(2)}`
      : live.analyzing
        ? `🔎 анализирую: ${live.analyzing === "searching" ? "ищу следующий тикет" : live.analyzing}`
        : "💤 сейчас ничего не выполняю";
    const lines = [
      doing,
      waitingOn ? `⏳ жду твоего решения по: ${waitingOn}` : "⏳ ничего не жду от тебя сейчас",
      autoPollActive(state)
        ? "🔁 автопоиск включён: сам беру задачи из очереди (/stop — выключить)"
        : `⚪️ автопоиск выключен, жду твоего выбора${state.running ? "" : " (/start — список задач)"}`,
      `💰 сегодня: $${costSince(state, startOfTodayIso()).toFixed(2)} из $${config.dailyBudgetUsd}, всего: $${totalCostUsd(state).toFixed(2)}`,
      last ? `последнее: ${last.issueKey} (${last.outcome}) — ${last.detail}` : "последнее: пока ничего",
    ];
    await ctx.reply(fitTelegram(lines.join("\n")));
  }
  bot.command("status", handleStatus);

  async function handleMetrics(ctx: Context): Promise<void> {
    const metrics = computeMetrics(state);
    if (!metrics) {
      await ctx.reply("📊 Пока нет ни одной закрытой или эскалированной задачи — рано считать метрики.");
      return;
    }
    const closedShare = Math.round((metrics.closedCount / metrics.totalTasks) * 100);
    const lines = [
      `📊 Метрики по ${metrics.totalTasks} задачам`,
      `✅ без эскалации: ${closedShare}% (${metrics.closedCount}/${metrics.totalTasks})`,
      `💰 стоимость: ~$${metrics.avgCostUsd.toFixed(4)} в среднем, $${metrics.medianCostUsd.toFixed(4)} медиана`,
      metrics.avgDurationMs !== null
        ? `⏱ тикет→MR: ~${Math.round(metrics.avgDurationMs / 60_000)} мин в среднем, ${Math.round(metrics.medianDurationMs! / 60_000)} мин медиана`
        : "⏱ тикет→MR: нет данных (история только из старых записей без durationMs)",
      metrics.avgReviewRounds !== null
        ? `🔁 раунды ревью на закрытую задачу: ~${metrics.avgReviewRounds.toFixed(1)}`
        : "🔁 раунды ревью: нет данных",
    ];
    const repoEntries = Object.entries(metrics.byRepo);
    if (repoEntries.length > 1) {
      lines.push("", "по репозиториям:");
      for (const [repo, m] of repoEntries) {
        lines.push(`  ${repo}: ${m.closed}/${m.total} без эскалации`);
      }
    }
    await ctx.reply(lines.join("\n"));
  }
  bot.command("metrics", handleMetrics);

  bot.callbackQuery(/^confirm:(.+)$/, async (ctx) => {
    const key = ctx.match[1];
    const pending = getLiveState().pendingApproval;
    if (!pending || pending.issueKey !== key) {
      await ctx.answerCallbackQuery({ text: "Это предложение уже неактуально.", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery({ text: "Запускаю… 🛠️" });
    const original = ctx.callbackQuery.message?.text ?? `${key}`;
    await ctx.editMessageText(original + "\n\n✅ Подтверждено, начинаю работу… 🛠️").catch(() => {});

    confirmPending()
      .then(async (outcome) => {
        if (!outcome) return;
        recordOutcome(state, outcome);
        if (outcome.kind === "needs_human") {
          await sendNeedsHumanReview(senderFor(ctx.chat!.id), outcome);
        } else if (outcome.kind === "brief_pending") {
          // The task is paused, not finished — don't show the ticket menu below until
          // this is answered (resolveBrief itself re-announces the next step).
          const pending = getLiveState().pendingBrief;
          if (pending)
            await ctx.reply(formatBrief(pending.issueKey, pending.brief, pending.crossRepo?.stage), {
              reply_markup: briefKeyboard(pending.issueKey, pending.brief),
            });
          return;
        } else {
          const text = describeOutcome(outcome);
          if (text) await senderFor(ctx.chat!.id)(text);
        }
        // Previously required a fresh /start after every single ticket — the queue
        // kept moving only as long as someone remembered to ask it to. Showing the
        // menu again right here keeps it going without that manual nudge.
        await sendTicketMenu(ctx, "Что дальше?");
      })
      .catch((err: Error) => sendSafe(ctx.chat!.id, `❌ ${key}: не получилось запустить — ${err.message}\nПредложение сохранено, можно нажать «Подтвердить» ещё раз.`));
  });

  bot.callbackQuery(/^cancel:(.+)$/, async (ctx) => {
    const key = ctx.match[1];
    const pending = getLiveState().pendingApproval;
    if (!pending || pending.issueKey !== key) {
      await ctx.answerCallbackQuery({ text: "Это предложение уже неактуально.", show_alert: true });
      return;
    }
    const cancelled = cancelPending();
    if (cancelled) {
      // Direct recordTask, not the generic recordOutcome helper: the analysis
      // turn's real cost (cancelled.costUsd) needs to count against the daily
      // budget even though no code was written — recordOutcome has no such field.
      recordTask(state, {
        issueKey: cancelled.issueKey,
        outcome: "skipped",
        detail: "отменено пользователем",
        costUsd: cancelled.costUsd,
        timestamp: new Date().toISOString(),
      });
    }
    await ctx.answerCallbackQuery({ text: "Отменено 🙅" });
    const original = ctx.callbackQuery.message?.text ?? `${key}`;
    await ctx.editMessageText(original + "\n\n❌ Отменено. Не будет предложен повторно до перезапуска бота.").catch(() => {});
    await sendTicketMenu(ctx, "Что дальше?");
  });

  bot.callbackQuery(/^accept_human:(.+)$/, async (ctx) => {
    const key = ctx.match[1];
    const pending = getLiveState().pendingHumanReview;
    if (!pending || pending.issueKey !== key) {
      await ctx.answerCallbackQuery({ text: "Это уже неактуально.", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery({ text: "Коммичу, пушу, открываю MR…" });
    const original = ctx.callbackQuery.message?.text ?? `${key}`;
    await ctx.editMessageText(original + "\n\n✅ Принято, пушу… 🛠️").catch(() => {});

    resolveHumanReview(true)
      .then(async (result) => {
        if (!result) return;
        if ("mrUrl" in result) {
          // The task's last history row says needs_human; without this it stays that
          // way forever and /metrics counts a shipped task as an escalation. The money
          // is already in history — costAlreadyRecordedUsd makes this a zero-cost row.
          recordOutcome(state, {
            kind: "closed",
            issueKey: result.issueKey,
            costUsd: result.costUsd,
            costAlreadyRecordedUsd: result.costUsd,
            mrUrl: result.mrUrl,
            durationMs: 0,
            repo: result.repo,
          });
          await ctx.reply(`✅ ${key}: запушено, ${result.mrUrl}`);
        }
        announceRecoveredCheckpoints();
        await sendTicketMenu(ctx, "Что дальше?");
      })
      .catch((err: Error) => sendSafe(ctx.chat!.id, `❌ ${key}: не удалось принять — ${err.message}\nЗадача по-прежнему ждёт решения, кнопки выше работают.`));
  });

  bot.callbackQuery(/^reject_human:(.+)$/, async (ctx) => {
    const key = ctx.match[1];
    const pending = getLiveState().pendingHumanReview;
    if (!pending || pending.issueKey !== key) {
      await ctx.answerCallbackQuery({ text: "Это уже неактуально.", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery({ text: "Отклоняю 🙅" });
    const original = ctx.callbackQuery.message?.text ?? `${key}`;
    await ctx.editMessageText(original + "\n\n❌ Отклонено, worktree удалён, тикет возвращён в «Сделать».").catch(() => {});

    resolveHumanReview(false)
      .then(() => {
        announceRecoveredCheckpoints();
        return sendTicketMenu(ctx, "Что дальше?");
      })
      .catch((err: Error) => sendSafe(ctx.chat!.id, `❌ ${key}: не удалось отклонить — ${err.message}\nЗадача по-прежнему ждёт решения, кнопки выше работают.`));
  });

  bot.callbackQuery(/^continue_human:(.+)$/, async (ctx) => {
    const key = ctx.match[1];
    const pending = getLiveState().pendingHumanReview;
    if (!pending || pending.issueKey !== key || !pending.resumeState) {
      await ctx.answerCallbackQuery({ text: "Это уже неактуально.", show_alert: true });
      return;
    }
    const how = pending.resumeState.freshSession ? "новой сессией" : "с того же места";
    await ctx.answerCallbackQuery({ text: `Продолжаю ${how}… 🛠️` });
    const original = ctx.callbackQuery.message?.text ?? `${key}`;
    await ctx.editMessageText(fitTelegram(original + `\n\n🔄 Продолжаю ${how}… 🛠️`)).catch(() => {});

    continueNeedsHuman()
      .then(async (outcome) => {
        if (!outcome) return;
        recordOutcome(state, outcome);
        if (outcome.kind === "needs_human") {
          await sendNeedsHumanReview(senderFor(ctx.chat!.id), outcome);
        } else if (outcome.kind === "brief_pending") {
          const next = getLiveState().pendingBrief;
          if (next)
            await ctx.reply(formatBrief(next.issueKey, next.brief, next.crossRepo?.stage), {
              reply_markup: briefKeyboard(next.issueKey, next.brief),
            });
          return;
        } else {
          const text = describeOutcome(outcome);
          if (text) await senderFor(ctx.chat!.id)(text);
        }
        await sendTicketMenu(ctx, "Что дальше?");
      })
      .catch((err: Error) => sendSafe(ctx.chat!.id, `❌ ${key}: не удалось продолжить — ${err.message}`));
  });

  bot.callbackQuery(/^brief_answer:([^:]+):(\d+)$/, async (ctx) => {
    const key = ctx.match[1];
    const chosenIndex = Number(ctx.match[2]);
    const pending = getLiveState().pendingBrief;
    if (!pending || pending.issueKey !== key) {
      await ctx.answerCallbackQuery({ text: "Это уже неактуально.", show_alert: true });
      return;
    }
    const chosenLabel = pending.brief.options[chosenIndex]?.label ?? `вариант ${chosenIndex + 1}`;
    await ctx.answerCallbackQuery({ text: "Продолжаю…" });
    const original = ctx.callbackQuery.message?.text ?? `${key}`;
    await ctx.editMessageText(original + `\n\n✅ Выбрано: ${chosenLabel}. Продолжаю работу… 🛠️`).catch(() => {});

    resolveBrief(chosenIndex)
      .then(async (outcome) => {
        if (!outcome) return;
        recordOutcome(state, outcome);
        if (outcome.kind === "needs_human") {
          await sendNeedsHumanReview(senderFor(ctx.chat!.id), outcome);
        } else if (outcome.kind === "brief_pending") {
          // Resumed, but the agent had ANOTHER question — same handling as the first.
          const next = getLiveState().pendingBrief;
          if (next)
            await ctx.reply(formatBrief(next.issueKey, next.brief, next.crossRepo?.stage), {
              reply_markup: briefKeyboard(next.issueKey, next.brief),
            });
          return;
        } else {
          const text = describeOutcome(outcome);
          if (text) await senderFor(ctx.chat!.id)(text);
        }
        await sendTicketMenu(ctx, "Что дальше?");
      })
      .catch((err: Error) => sendSafe(ctx.chat!.id, `❌ ${key}: не удалось продолжить — ${err.message}`));
  });

  // Free-form chat: anything that isn't a recognized slash command. A tiny Claude turn
  // (no tools — pure text classification) decides whether it maps to one of the real
  // commands or is just conversation. It only ever picks WHICH existing handler to call;
  // the handler itself fetches the real data, so a chat answer about status/budget/etc.
  // can never be a hallucinated number — only "chat" replies are Claude's own words.
  interface ChatIntent {
    intent: "status" | "metrics" | "budget" | "list" | "peek" | "kill" | "help" | "retry" | "chat";
    key?: string;
    reply?: string;
  }

  function parseChatIntent(raw: string): ChatIntent {
    const cleaned = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    try {
      const parsed: unknown = JSON.parse(cleaned);
      if (parsed && typeof parsed === "object" && typeof (parsed as ChatIntent).intent === "string") {
        return parsed as ChatIntent;
      }
    } catch {
      // Claude didn't return valid JSON — fall back to treating its raw text as a chat reply
      // rather than failing outright; still better than silence.
    }
    return { intent: "chat", reply: raw.trim() || "Не понял, можешь переформулировать?" };
  }

  // This is the actual conversational half of the "Зам. CEO" persona — everywhere else
  // in this file reports structured outcomes, but a free-text message is exactly where
  // the user is talking to someone, not clicking a button. The model answers in
  // character, but never invents bot data: a request for real numbers (cost/status/
  // queue) always becomes an intent the bot resolves with real data, never a guessed
  // "chat" reply.
  async function classifyMessage(text: string): Promise<ChatIntent> {
    const prompt = [
      "Ты — Зам. CEO внутри бота jira-harness: ты на прямой связи с CEO по работе над",
      "тикетами из Jira. Любое его сообщение без команды попадает сюда. Если ответ требует",
      "РЕАЛЬНЫХ живых данных (расход, статус, очередь) — не выдумывай их сам, выбери",
      "соответствующий intent: бот сходит за настоящими данными и пришлёт их отдельным",
      "сообщением, это и есть смысл JSON-метки ниже.",
      "",
      "Ответь СТРОГО одним JSON-объектом, без текста до/после и без markdown-разметки,",
      "одной из форм:",
      "",
      '{"intent":"status"} — что сейчас происходит, запущено ли, что последнее обработано',
      '{"intent":"metrics"} — исторический трек-рекорд: доля задач без эскалации, средние',
      "  стоимость/время/раунды ревью за всё время (не про бюджет на сегодня — это budget)",
      '{"intent":"budget"} — расход/бюджет/сколько потрачено/сколько задач за сегодня',
      '{"intent":"list"} — показать список задач / начать работу над чем-то / что взять в работу',
      '{"intent":"peek"} — глянуть следующую задачу в очереди, не запуская',
      '{"intent":"kill"} — остановить/прервать текущую работу',
      '{"intent":"retry","key":"XEN-123"} — вернуть конкретный тикет (укажи ключ) в очередь',
      '{"intent":"help"} — что ты умеешь / как тобой пользоваться',
      '{"intent":"chat","reply":"..."} — когда сообщение не про живые данные и не про одну из',
      "  команд выше (обычный разговор, вопрос не по теме, благодарность и т.п.). reply —",
      "  твой ответ ОТ СВОЕГО ЛИЦА: по-деловому, но по-человечески, коротко, на русском,",
      "  без канцелярита и без фраз вроде «я бот/ассистент». Не выдумывай цифры бота здесь —",
      "  если нужны именно они, это всегда status/metrics/budget/list/peek, а не chat.",
      "",
      // Reproduced live: without this, a casual question about how the bot handles a
      // hard task got two DIFFERENT invented answers in a row ("делю на подзадачи, ищу
      // аналоги в кодбейсе" — not a real behavior at all) — confident-sounding but
      // false, because Haiku had no actual facts to ground a "chat" reply in and just
      // freestyled something plausible each time. If the CEO asks how/why the bot does
      // something, answer using ONLY these real facts, never invented behavior:
      "Если вопрос — о том, как или почему ты (бот) что-то делаешь, отвечай ТОЛЬКО этими",
      "реальными фактами о механике, ничего не придумывая сверх них:",
      "- Реализация: до MAX_ITERATIONS попыток одной сессией; после каждой — гейты",
      "  (typecheck/lint/test/build/acceptance), провал — фидбек той же сессии дальше.",
      "- Та же ошибка гейта два раза подряд (stuck), лимит бюджета/итераций, или слишком",
      "  раздувшийся контекст сессии (риск деградации ответов) — останавливаюсь и зову",
      "  тебя, сам ничего не выдумываю взамен.",
      "- По-настоящему неоднозначный момент при реализации — присылаю бриф с вариантами",
      "  вместо того, чтобы угадывать самому.",
      "- После успешной реализации — независимое ревью другой моделью; блокирующие",
      "  замечания уходят на фикс мне же, не сразу тебе.",
      "- Любая такая остановка — не провал, а решение, которое жду от тебя: принять",
      "  диф как есть, отклонить, или (только для лимита контекста) продолжить заново",
      "  свежей сессией.",
      "",
      'Сомневаешься между командой и chat — выбирай команду: худший случай — лишний,',
      "но верный ответ, а не отказ там, где ты мог помочь.",
      "",
      `Сообщение CEO: "${text}"`,
    ].join("\n");

    const turn = await runClaudeTurn({
      // Not the harness's own directory: nothing here needs files, and an empty temp
      // dir means there's nothing to read even if a tool slipped through.
      cwd: tmpdir(),
      prompt,
      permissionMode: "acceptEdits",
      // Pure classification — no file/shell access needed or wanted.
      disallowedToolsOverride: "Bash,Edit,Write,MultiEdit,Read,Grep,Glob,WebFetch,WebSearch,NotebookEdit,Task",
      model: config.models.chat,
      // A chat reply isn't task work — /kill must not hit it (see processRegistry.ts).
      killable: false,
    });
    return parseChatIntent(turn.resultText);
  }

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    // Slash commands are handled by the registrations above; an unmatched one (typo,
    // unknown command) falls through to here too — don't hand that to the classifier.
    if (!text) return;
    if (text.startsWith("/")) {
      // A mistyped command used to get no answer at all.
      await ctx.reply(`Не знаю команды ${text.split(/\s+/)[0]} — список в /help.`);
      return;
    }

    const thinking = await ctx.reply("💬 Думаю…");
    const clear = () => ctx.api.deleteMessage(ctx.chat!.id, thinking.message_id).catch(() => {});
    try {
      const parsed = await classifyMessage(text);
      switch (parsed.intent) {
        case "status":
          await clear();
          await handleStatus(ctx);
          break;
        case "metrics":
          await clear();
          await handleMetrics(ctx);
          break;
        case "budget":
          await clear();
          await handleBudget(ctx);
          break;
        case "list":
          await clear();
          await sendTicketMenu(ctx, undefined, { resume: true });
          break;
        case "peek":
          await clear();
          await handlePeek(ctx);
          break;
        case "kill":
          await clear();
          await handleKill(ctx);
          break;
        case "help":
          await clear();
          await handleHelp(ctx);
          break;
        case "retry": {
          const key = parsed.key?.trim().toUpperCase();
          await clear();
          if (key && /^[A-Z]+-\d+$/.test(key)) await handleRetry(ctx, key);
          else await ctx.reply("Не понял, какой тикет вернуть в очередь — укажи ключ вида XEN-123.");
          break;
        }
        case "chat":
        default:
          await ctx.api
            .editMessageText(ctx.chat!.id, thinking.message_id, parsed.reply || "Не понял, можешь переформулировать?")
            .catch(() => ctx.reply(parsed.reply || "Не понял, можешь переформулировать?"));
      }
    } catch (err) {
      await ctx.api
        .editMessageText(ctx.chat!.id, thinking.message_id, `❌ Не удалось обработать: ${(err as Error).message}`)
        .catch(() => {});
    }
  });

  // Without this, grammY rethrows any handler error as an unhandled rejection and
  // takes the whole process down (observed live: a bad /dashboard button URL killed
  // the bot mid-session). One bad command must not stop the queue loop for everyone.
  bot.catch((err) => {
    console.error("[bot] handler error (ignored, bot keeps running):", err.message);
    // The person who pressed the button otherwise sees nothing happen at all.
    const chatId = err.ctx.chat?.id;
    if (chatId) void sendSafe(chatId, `❌ Внутренняя ошибка при обработке: ${err.message.slice(0, 300)}`);
  });

  console.log(`[bot] starting, allowed chats: ${config.telegram.allowedChatIds.join(", ")}`);
  // setBotRunning(false) above only covers "a stale `true` survived a crash"; nothing
  // ever set it back to true, so /api/state's botRunning was permanently false the
  // entire time the bot was actually up and handling messages (reproduced live:
  // dashboard showed "not running" while a real job was mid-flight). grammY's onStart
  // fires once getMe succeeds and polling has actually begun — the earliest point
  // "the bot is running" is true, not just "the process started".
  await bot.start({ onStart: () => setBotRunning(true) });
}
