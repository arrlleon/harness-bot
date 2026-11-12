// What the bot says about a task, and how. Every task message opens with a category
// line ("📋 ПРЕДЛОЖЕНИЕ · XEN-381") so it's clear at a glance whether it's news or a
// request for a decision, and no message shows raw harness output: stop reasons are
// translated into what happened and what the human can do about it.
//
// Reproduced live (XEN-381, 2026-11-12): "⚠️ Застрял на XEN-381 (rebase_conflict (dev
// moved on ...): error: Entry ... not uptodate" left the reader unable to tell whether
// the task had failed, finished, or was waiting on them, and "Продолжить" got pressed
// where "Принять" was meant.

export const CATEGORY = {
  analysis: "🔎 АНАЛИЗ",
  proposal: "📋 ПРЕДЛОЖЕНИЕ",
  working: "🛠 В РАБОТЕ",
  question: "❓ ВОПРОС",
  decision: "⚠️ НУЖНО ТВОЁ РЕШЕНИЕ",
  done: "✅ ГОТОВО",
  skipped: "⏭ ПРОПУЩЕНО",
  paused: "⏸ ПАУЗА",
  error: "❌ ОШИБКА",
  reminder: "🔄 НАПОМИНАНИЕ",
} as const;

export function headline(category: keyof typeof CATEGORY, issueKey?: string): string {
  return issueKey ? `${CATEGORY[category]} · ${issueKey}` : CATEGORY[category];
}

const MONEY = (usd: number): string => `$${usd.toFixed(2)}`;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1).trimEnd() + "…" : flat;
}

export interface StopExplanation {
  // One sentence: what happened, in plain words.
  why: string;
  // Whether the "continue with the agent" button makes sense for this kind of stop.
  continueUseful: boolean;
}

// The reason strings come from queue.ts (buildFailureReason, escalateFailure, the
// push/MR path and the cross-repo wrappers). Matched by their leading code; anything
// unrecognised still gets a readable sentence rather than the raw text.
export function explainStop(reason: string): StopExplanation {
  const r = reason.trim();
  const cross = /^(backend|frontend): ([\s\S]*)$/.exec(r);
  if (cross) {
    const inner = explainStop(cross[2].replace(/\s*\(backend already opened: [^)]*\)\s*$/, ""));
    const part = cross[1] === "backend" ? "Бэкенд-часть" : "Фронтенд-часть (бэкенд уже в MR)";
    return { ...inner, why: `${part}: ${lowerFirst(inner.why)}` };
  }
  const resumeFailed = /^([\s\S]*?) · продолжение не удалось: ([\s\S]*)$/.exec(r);
  if (resumeFailed) {
    const inner = explainStop(resumeFailed[1]);
    return { ...inner, why: `${inner.why} Попытка продолжить тоже не удалась.` };
  }
  if (r.startsWith("context_budget")) {
    const gates = /не прошли гейты: (.+)$/.exec(r)?.[1];
    return {
      why: `У агента переполнилась память сессии — дальше он начал бы путаться.${gates ? ` Не проходят проверки: ${gateNames(gates)}.` : ""}`,
      continueUseful: true,
    };
  }
  if (r.startsWith("max_budget")) return { why: "Закончился бюджет на задачу, работа не доведена до конца.", continueUseful: false };
  if (r.startsWith("max_iterations")) return { why: "Агент исчерпал попытки, а проверки так и не прошли.", continueUseful: false };
  if (r.startsWith("stuck")) {
    const gates = /in: ([^)]+)\)/.exec(r)?.[1];
    return { why: `Агент два раза подряд получил одну и ту же ошибку${gates ? ` (${gateNames(gates)})` : ""} — дальше крутился бы на месте.`, continueUseful: false };
  }
  if (r.startsWith("review_blocked")) {
    if (/ревью не состоялось/.test(r)) return { why: "Независимое ревью не удалось провести — изменения никто не проверил.", continueUseful: false };
    const findings = r.replace(/^review_blocked[^:]*:\s*/, "");
    return { why: `Ревью нашло проблемы, которые агент не исправил: ${clip(findings, 300)}`, continueUseful: false };
  }
  if (r.startsWith("gate_integrity_violation")) {
    return { why: "Агент тронул сами проверки (тесты или их настройки) — такое автоматически не принимаю, нужен твой взгляд.", continueUseful: false };
  }
  if (r.startsWith("agent_error")) return { why: "Агент прервался посреди работы (лимит аккаунта, бюджет хода или сбой).", continueUseful: true };
  if (r.startsWith("rebase_conflict")) {
    return { why: "Пока задача стояла на паузе, в dev появились изменения, и совместить их с работой автоматически не вышло.", continueUseful: false };
  }
  if (r.startsWith("push/MR failed")) return { why: "Работа готова, но не удалось запушить ветку или открыть MR в GitLab.", continueUseful: false };
  if (r.startsWith("остановлено вручную")) return { why: "Работа остановлена командой /kill.", continueUseful: true };
  if (r.startsWith("сбой харнесса")) return { why: "Внутренний сбой бота посреди работы — сделанное сохранено.", continueUseful: true };
  return { why: "Работа остановилась по необычной причине — подробности на дашборде.", continueUseful: false };
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

const GATE_RU: Record<string, string> = {
  typecheck: "типы",
  lint: "линтер",
  test: "тесты",
  build: "сборка",
  acceptance: "приёмочный тест",
};

function gateNames(list: string): string {
  return list
    .split(/,\s*/)
    .map((g) => GATE_RU[g.trim()] ?? g.trim())
    .join(", ");
}

export interface DiffStats {
  files: Array<{ path: string; added: number; removed: number; isNew: boolean }>;
  added: number;
  removed: number;
}

export function diffStats(diff: string): DiffStats {
  const files: DiffStats["files"] = [];
  let current: DiffStats["files"][number] | null = null;
  for (const line of diff.split("\n")) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (header) {
      current = { path: header[2], added: 0, removed: 0, isNew: false };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("new file mode")) current.isNew = true;
    else if (line.startsWith("+") && !line.startsWith("+++")) current.added++;
    else if (line.startsWith("-") && !line.startsWith("---")) current.removed++;
  }
  return { files, added: files.reduce((s, f) => s + f.added, 0), removed: files.reduce((s, f) => s + f.removed, 0) };
}

const MAX_LISTED_FILES = 8;

export interface DecisionInput {
  issueKey: string;
  title?: string;
  reason: string;
  costUsd: number;
  budgetUsd?: number;
}

// The "bot stopped, choose what to do" message. Short by design: what happened, what
// is already done, what each button will do. The full diff lives on the dashboard and
// in the MR, not in a chat message.
export function composeDecisionText(input: DecisionInput, diff: string | null, canContinue: boolean): string {
  const { why } = explainStop(input.reason);
  const lines = [headline("decision", input.issueKey)];
  if (input.title) lines.push(clip(input.title, 120));
  lines.push("", `Что случилось: ${why}`);

  if (diff !== null) {
    const stats = diffStats(diff);
    if (stats.files.length === 0) {
      lines.push("Сделано: изменений в коде нет.");
    } else {
      lines.push(`Сделано: ${stats.files.length} файл(ов), +${stats.added} −${stats.removed}`);
      for (const f of stats.files.slice(0, MAX_LISTED_FILES)) {
        lines.push(`  • ${f.isNew ? "новый " : ""}${shortPath(f.path)}`);
      }
      if (stats.files.length > MAX_LISTED_FILES) lines.push(`  • …и ещё ${stats.files.length - MAX_LISTED_FILES}`);
    }
  }
  lines.push(`Потрачено: ${MONEY(input.costUsd)}${input.budgetUsd ? ` из ${MONEY(input.budgetUsd)}` : ""}`);

  lines.push("", "Что можно сделать:");
  if (diff === null || diffStats(diff).files.length > 0) lines.push("🚀 Открыть MR — запушу сделанное как есть, проверишь сам");
  if (canContinue) lines.push("🔄 Доработать — агент продолжит в новой сессии с того, что уже сделано");
  lines.push("🗑 Выбросить — удалю работу, тикет вернётся в «Сделать»");
  return lines.join("\n");
}

function shortPath(path: string): string {
  const parts = path.split("/");
  return parts.length > 3 ? `…/${parts.slice(-2).join("/")}` : path;
}

export const DECISION_BUTTONS = {
  accept: "🚀 Открыть MR",
  continue: "🔄 Доработать",
  reject: "🗑 Выбросить",
  confirmReject: "🗑 Да, выбросить",
  keep: "↩️ Нет, оставить",
} as const;

export const PROPOSAL_BUTTONS = {
  confirm: "▶️ Взять в работу",
  cancel: "✖️ Не брать",
} as const;

export interface ProgressInput {
  issueKey: string;
  title: string;
  phaseLabel: string;
  activity: string | null;
  iteration: number;
  maxIterations: number;
  costUsd: number;
  budgetUsd: number;
  startedAt: string;
  now: Date;
}

export function composeProgressText(p: ProgressInput): string {
  const minutes = Math.max(0, Math.round((p.now.getTime() - new Date(p.startedAt).getTime()) / 60_000));
  const time = p.now.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Almaty" });
  const lines = [headline("working", p.issueKey), clip(p.title, 120), ""];
  lines.push(`Сейчас: ${p.activity ?? p.phaseLabel}`);
  if (p.activity) lines.push(`Этап: ${p.phaseLabel}`);
  if (p.iteration > 0) lines.push(`Попытка: ${p.iteration} из ${p.maxIterations}`);
  lines.push(`Идёт ${minutes} мин · потрачено ${MONEY(p.costUsd)} из ${MONEY(p.budgetUsd)}`);
  lines.push(`(обновлено в ${time}, следующее обновление через 5 мин)`);
  return lines.join("\n");
}

export const PHASE_RU: Record<string, string> = {
  transitioning: "перевожу тикет в Jira",
  writing_acceptance_test: "пишу приёмочный тест по критериям",
  baseline: "прогоняю проверки на исходном коде",
  iterating: "пишу код",
  verifying: "прогоняю проверки (типы, тесты, сборка)",
  checking_gate_integrity: "проверяю, что проверки не ослаблены",
  reviewing: "независимое ревью изменений",
  writing_testing_notes: "пишу инструкцию для тестировщика",
  writing_close_report: "пишу итоговую сводку",
  updating_memory: "обновляю заметки о проекте",
  pushing: "пушу ветку",
  opening_mr: "открываю MR",
  commenting: "пишу комментарий в Jira",
};
