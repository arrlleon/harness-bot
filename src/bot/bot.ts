import { Bot, InlineKeyboard, type Context } from "grammy";
import { config } from "../config.js";
import { loadState, saveState, recordTask, recordOutcome, totalCostUsd, costSince, countSince, startOfTodayIso, type BotState } from "./state.js";
import { setBotRunning, getLiveState, loadPersistedPending } from "./liveState.js";
import { recoverOrphanedCheckpoints } from "../engine/checkpoint.js";
import { startDashboardServer, dashboardUrl } from "../web/server.js";
import {
  peekNext,
  retryIssue,
  confirmPending,
  cancelPending,
  listMenuCandidates,
  proposeIssueByKey,
  getPendingHumanReviewDiff,
  resolveHumanReview,
  type Proposal,
  type Candidate,
} from "../queue.js";
import { killCurrentTurn, runClaudeTurn } from "../engine/claudeEngine.js";
import type { QueueRunOutcome } from "../types.js";

const REPO_RU: Record<string, string> = { backend: "бэкенд", frontend: "фронтенд" };

function statusTag(status: string | undefined): string {
  if (status === config.jira.inProgressStatus) return "[IN WORK]";
  if (status === config.jira.todoStatus) return "[TO DO]";
  return "[?]"; // shouldn't happen — listMenuCandidates already filters to these two
}

const HELP_TEXT = [
  "jira-harness — забирает назначенные тебе тикеты из Jira, предлагает решение и, после твоего подтверждения, реализует, проверяет, открывает MR и переводит на ревью.",
  "",
  "/start — показать список твоих задач («Сделать» + «В работе») с кнопками, выбрать — начнётся анализ именно этой",
  "/stop — деактивировать кнопки уже показанных списков (текущая работа и ожидающее подтверждение не затрагиваются)",
  "/kill — немедленно прервать текущий ход агента (если завис или делает не то)",
  "/status — состояние, расход, последний обработанный тикет",
  "/budget — расход/число задач за сегодня относительно дневных лимитов",
  "/peek — показать следующий тикет в очереди, не запуская его",
  "/retry XEN-123 — вернуть тикет, застрявший в «нужен человек», обратно в очередь",
  "«нужен человек» теперь сразу показывает diff с кнопками ✅ Принять/❌ Отклонить — можно запушить уже сделанную работу вручную, даже если харнесс сам сдался",
  "/dashboard — ссылка на живой локальный дашборд",
  "/help — это сообщение",
  "",
  "Можно просто написать сообщение без команды (вопрос, просьба) — отвечу или выполню нужную команду, если это похоже на одну из них.",
].join("\n");

function describeOutcome(outcome: QueueRunOutcome | { kind: "error"; message: string }): string | null {
  switch (outcome.kind) {
    case "empty":
      return null;
    case "paused":
      return `⏸ пауза: ${outcome.reason}`;
    case "busy":
      return null;
    case "skipped":
      return `⏭ ${outcome.issueKey}: пропущен (${outcome.reason})`;
    case "needs_human":
      return `⚠️ ${outcome.issueKey}: нужен человек (${outcome.reason}), потрачено $${outcome.costUsd.toFixed(4)}`;
    case "closed":
      return `✅ ${outcome.issueKey}: закрыт, ${outcome.mrUrl}, потрачено $${outcome.costUsd.toFixed(4)}`;
    case "error":
      return `❌ ошибка: ${outcome.message}`;
  }
}

// MarkdownV2's reserved set (Telegram Bot API docs) — any of these appearing as literal
// text, not as formatting we deliberately wrote, must be backslash-escaped or the whole
// message is rejected outright. Jira text routinely contains most of these (code in
// backticks, parenthesized asides, "a.b.c" paths, "foo-bar" identifiers), so this has to
// run over every piece of dynamic text before it goes anywhere near our own `*`/`>`/`||`.
function escapeMarkdownV2(text: string): string {
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
function formatProposal(p: Proposal): string {
  const header = [
    `🆕 *${escapeMarkdownV2(p.issueKey)}*: ${escapeMarkdownV2(p.title)}`,
    `📦 репозиторий: ${escapeMarkdownV2(REPO_RU[p.repo] ?? p.repo)}`,
    // toFixed's decimal point is itself a reserved MarkdownV2 character — reproduced
    // live ("Character '.' is reserved"), easy to miss since it looks like plain text.
    `💸 анализ стоил $${escapeMarkdownV2(p.costUsd.toFixed(4))}`,
  ].join("\n");

  const bodyLines = [
    "📋 Описание:",
    ...escapeMarkdownV2(p.descriptionShort || "(нет описания)").split("\n"),
    "",
    "💡 Предлагаемое решение:",
    ...escapeMarkdownV2(p.plan || "(нет плана)").split("\n"),
  ];

  return [header, "", expandableBlockquote(bodyLines)].join("\n");
}

const MAX_DIFF_CHARS = 3200; // Telegram's 4096 message cap minus room for the header/buttons text

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
  try {
    diff = await getPendingHumanReviewDiff();
  } catch (err) {
    await send(`⚠️ ${outcome.issueKey}: нужен человек (${outcome.reason}), потрачено $${outcome.costUsd.toFixed(4)}\nНе удалось прочитать diff: ${(err as Error).message}`);
    return;
  }
  if (!diff) {
    // pendingHumanReview was already cleared somehow (e.g. a second needs_human
    // landed before this one was reviewed) — nothing to show, say so plainly.
    await send(`⚠️ ${outcome.issueKey}: нужен человек (${outcome.reason}), потрачено $${outcome.costUsd.toFixed(4)}`);
    return;
  }
  const truncated = diff.length > MAX_DIFF_CHARS;
  const diffText = truncated ? diff.slice(0, MAX_DIFF_CHARS) + "\n… (обрезано, полный diff в worktree)" : diff;
  const text = [
    `⚠️ ${outcome.issueKey}: нужен человек (${outcome.reason}), потрачено $${outcome.costUsd.toFixed(4)}`,
    "",
    diff.trim() ? diffText : "(diff пустой — похоже, агент ничего не изменил)",
  ].join("\n");
  const keyboard = new InlineKeyboard()
    .text("✅ Принять и запушить", `accept_human:${outcome.issueKey}`)
    .text("❌ Отклонить", `reject_human:${outcome.issueKey}`);
  await send(text, keyboard);
}

export async function startBot(): Promise<void> {
  if (!config.telegram.botToken) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  if (config.telegram.allowedChatIds.length === 0) {
    throw new Error("TELEGRAM_ALLOWED_CHAT_IDS is not set — refusing to start an open bot");
  }

  const bot = new Bot(config.telegram.botToken);
  const state: BotState = loadState();
  // A crash or hard kill can leave `running: true` on disk with nothing actually
  // polling; on a fresh process start no loop can possibly be alive yet, so the
  // persisted flag would otherwise lie to /status until the next /start or /stop.
  state.running = false;
  saveState(state);
  setBotRunning(false);

  startDashboardServer(config.dashboard.port, state);

  // A restart loses nothing mid-decision: a pending proposal or needs_human review has
  // no running process behind it (that already finished) — only the bot's own memory of
  // it, which loadPersistedPending() just restored from disk. Re-announce it so it isn't
  // silently sitting there until someone happens to check /status.
  const restored = loadPersistedPending();
  const announceChatId = config.telegram.allowedChatIds[0];
  const announce: Sender = (text, keyboard) => bot.api.sendMessage(announceChatId, text, keyboard ? { reply_markup: keyboard } : undefined);
  if (restored.pendingApproval) {
    const p = restored.pendingApproval;
    const keyboard = new InlineKeyboard().text("✅ Подтвердить", `confirm:${p.issueKey}`).text("❌ Отменить", `cancel:${p.issueKey}`);
    // formatProposal's output is MarkdownV2 (the expandable blockquote) — unlike the
    // plain-text `announce` used below for needs_human, this one needs parse_mode set.
    bot.api
      .sendMessage(announceChatId, "🔄 Восстановлено после перезапуска:\n\n" + formatProposal(p), { reply_markup: keyboard, parse_mode: "MarkdownV2" })
      .catch(() => {});
  }
  if (restored.pendingHumanReview) {
    const p = restored.pendingHumanReview;
    sendNeedsHumanReview(
      (text, keyboard) => announce("🔄 Восстановлено после перезапуска:\n\n" + text, keyboard),
      { issueKey: p.issueKey, reason: p.reason, costUsd: p.costUsd },
    ).catch(() => {});
  }

  // A checkpoint left on disk means the process died mid-iteration last run (not a
  // clean needs_human stop — those are already covered by restored.pendingHumanReview
  // above). The worktree's uncommitted work is still sitting right where the agent
  // left it; surface it the same way so nothing from a crash is ever just silently lost.
  for (const { checkpoint, reason } of recoverOrphanedCheckpoints()) {
    sendNeedsHumanReview(
      (text, keyboard) => announce("⚠️ Найдена прерванная перезапуском задача:\n\n" + text, keyboard),
      { issueKey: checkpoint.issueKey, reason, costUsd: checkpoint.costUsd },
    ).catch(() => {});
  }

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
  async function sendTicketMenu(ctx: Context, intro = "Выбери задачу, которую взять в работу:"): Promise<void> {
    state.running = true;
    saveState(state);
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

  bot.command("start", (ctx) => sendTicketMenu(ctx));

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
        const text = formatProposal(outcome.proposal);
        const editedOk = await ctx.api
          .editMessageText(ctx.chat!.id, msg.message_id, text, { reply_markup: keyboard, parse_mode: "MarkdownV2" })
          .then(() => true)
          .catch(() => false);
        if (!editedOk) await ctx.reply(text, { reply_markup: keyboard, parse_mode: "MarkdownV2" });
      } else if (outcome.kind === "skipped") {
        await ctx.api
          .editMessageText(ctx.chat!.id, msg.message_id, `⏭️ ${outcome.issueKey}: пропущен (${outcome.reason})`)
          .catch(() => ctx.reply(`⏭️ ${outcome.issueKey}: пропущен (${outcome.reason})`));
      } else if (outcome.kind === "paused") {
        await ctx.api
          .editMessageText(ctx.chat!.id, msg.message_id, `⏸ Пауза: ${outcome.reason}`)
          .catch(() => ctx.reply(`⏸ Пауза: ${outcome.reason}`));
      } else {
        // awaiting_approval / busy: a race with another chat action between the
        // guards above and the actual propose call.
        await ctx.api
          .editMessageText(ctx.chat!.id, msg.message_id, "Не удалось начать — попробуй ещё раз через /start.")
          .catch(() => {});
      }
    } catch (err) {
      await ctx.api
        .editMessageText(ctx.chat!.id, msg.message_id, `❌ Ошибка: ${(err as Error).message}`)
        .catch(() => ctx.reply(`❌ Ошибка: ${(err as Error).message}`));
    }
  });

  async function handleStop(ctx: Context): Promise<void> {
    state.running = false;
    saveState(state);
    await ctx.reply("🛑 Ок. Кнопки в уже показанных списках задач больше не сработают — вызови /start заново, когда понадобится.");
  }
  bot.command("stop", handleStop);

  async function handleKill(ctx: Context): Promise<void> {
    state.running = false;
    saveState(state);
    const killed = killCurrentTurn();
    await ctx.reply(killed ? "⛔ Прервал текущий ход. Поиск новых тикетов тоже останавливаю." : "🤷 Сейчас ничего не выполняется. Останавливаю поиск новых тикетов.");
  }
  bot.command("kill", handleKill);

  async function handleBudget(ctx: Context): Promise<void> {
    const todayIso = startOfTodayIso();
    const spent = costSince(state, todayIso);
    const tasks = countSince(state, todayIso);
    const lines = [
      "💰 Бюджет",
      `потрачено сегодня: $${spent.toFixed(4)} / $${config.dailyBudgetUsd}`,
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
          ? `репозиторий: ${REPO_RU[detection.kind]}`
          : detection.kind === "ambiguous"
            ? "репозиторий: неоднозначно (backend+frontend) — будет пропущен"
            : "репозиторий: не определён (нет префикса) — будет пропущен";
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
    const pending = getLiveState().pendingApproval;
    const lines = [
      `${state.running ? "🟢" : "⚪️"} запущено: ${state.running ? "да" : "нет"}`,
      `💰 всего потрачено: $${totalCostUsd(state).toFixed(4)}`,
      `сегодня: $${costSince(state, startOfTodayIso()).toFixed(4)}`,
      `📈 задач обработано: ${state.history.length}`,
      pending ? `⏳ ждёт подтверждения: ${pending.issueKey}` : "⏳ ждёт подтверждения: ничего",
      last ? `последний: ${last.issueKey} (${last.outcome}) — ${last.detail}` : "последний: пока нет",
    ];
    await ctx.reply(lines.join("\n"));
  }
  bot.command("status", handleStatus);

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
          await sendNeedsHumanReview((text, keyboard) => ctx.reply(text, keyboard ? { reply_markup: keyboard } : undefined), outcome);
        } else {
          const text = describeOutcome(outcome);
          if (text) await ctx.reply(text);
        }
        // Previously required a fresh /start after every single ticket — the queue
        // kept moving only as long as someone remembered to ask it to. Showing the
        // menu again right here keeps it going without that manual nudge.
        await sendTicketMenu(ctx, "Что дальше?");
      })
      .catch((err: Error) => ctx.reply(`❌ ошибка: ${err.message}`));
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
        if ("mrUrl" in result) await ctx.reply(`✅ ${key}: запушено, ${result.mrUrl}`);
        await sendTicketMenu(ctx, "Что дальше?");
      })
      .catch((err: Error) => ctx.reply(`❌ ${key}: не удалось принять — ${err.message}`));
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
      .then(() => sendTicketMenu(ctx, "Что дальше?"))
      .catch((err: Error) => ctx.reply(`❌ ${key}: не удалось отклонить — ${err.message}`));
  });

  // Free-form chat: anything that isn't a recognized slash command. A tiny Claude turn
  // (no tools — pure text classification) decides whether it maps to one of the real
  // commands or is just conversation. It only ever picks WHICH existing handler to call;
  // the handler itself fetches the real data, so a chat answer about status/budget/etc.
  // can never be a hallucinated number — only "chat" replies are Claude's own words.
  interface ChatIntent {
    intent: "status" | "budget" | "list" | "peek" | "kill" | "help" | "retry" | "chat";
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

  async function classifyMessage(text: string): Promise<ChatIntent> {
    const prompt = [
      "Ты — диспетчер Telegram-бота jira-harness (автоматизация закрытия тикетов Jira), а",
      "не сам бот: ты ТОЛЬКО выбираешь, какую из его команд вызвать. Сам бот, получив",
      "выбранный intent, сходит за РЕАЛЬНЫМИ живыми данными (расход, статус, очередь) и",
      "пришлёт их отдельным сообщением — твоя JSON-метка это и запускает. Поэтому если",
      "сообщение спрашивает именно о таких живых данных, уверенно выбирай intent status/",
      "budget/list/peek, а НЕ chat — у бота эти данные есть, просто не в этом сообщении.",
      "",
      "Ответь СТРОГО одним JSON-объектом, без текста до/после и без markdown-разметки,",
      "одной из форм:",
      "",
      '{"intent":"status"} — что сейчас происходит, запущено ли, что последнее обработано',
      '{"intent":"budget"} — расход/бюджет/сколько потрачено/сколько задач за сегодня',
      '{"intent":"list"} — показать список задач / начать работу над чем-то / что взять в работу',
      '{"intent":"peek"} — глянуть следующую задачу в очереди, не запуская',
      '{"intent":"kill"} — остановить/прервать текущую работу',
      '{"intent":"retry","key":"XEN-123"} — вернуть конкретный тикет (укажи ключ) в очередь',
      '{"intent":"help"} — что бот умеет / как пользоваться',
      '{"intent":"chat","reply":"..."} — ТОЛЬКО когда сообщение не про живые данные бота и не',
      "  про одну из команд выше (обычный разговор, вопрос не по теме харнесса, благодарность",
      "  и т.п.); reply — твой короткий полезный ответ на русском. Не выдумывай цифры бота",
      "  здесь — если нужны именно они, это всегда status/budget/list/peek, а не chat.",
      "",
      'Сомневаешься между командой и chat — выбирай команду: худший случай — лишний,',
      "но верный ответ, а не отказ там, где бот мог помочь.",
      "",
      `Сообщение пользователя: "${text}"`,
    ].join("\n");

    const turn = await runClaudeTurn({
      cwd: process.cwd(),
      prompt,
      permissionMode: "acceptEdits",
      // Pure classification — no file/shell access needed or wanted.
      disallowedToolsOverride: "Bash,Edit,Write,MultiEdit,Read,Grep,Glob,WebFetch,WebSearch,NotebookEdit,Task",
      model: config.models.chat,
    });
    return parseChatIntent(turn.resultText);
  }

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    // Slash commands are handled by the registrations above; an unmatched one (typo,
    // unknown command) falls through to here too — don't hand that to the classifier.
    if (!text || text.startsWith("/")) return;

    const thinking = await ctx.reply("💬 Думаю…");
    const clear = () => ctx.api.deleteMessage(ctx.chat!.id, thinking.message_id).catch(() => {});
    try {
      const parsed = await classifyMessage(text);
      switch (parsed.intent) {
        case "status":
          await clear();
          await handleStatus(ctx);
          break;
        case "budget":
          await clear();
          await handleBudget(ctx);
          break;
        case "list":
          await clear();
          await sendTicketMenu(ctx);
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
  });

  console.log(`[bot] starting, allowed chats: ${config.telegram.allowedChatIds.join(", ")}`);
  await bot.start();
}
