import { config, type RepoKind } from "../config.js";
import type { TaskSpec } from "../types.js";
import { runClaudeTurn } from "./claudeEngine.js";
import { parseProposalResponse } from "./proposal.js";
import { readMemoryFiles, buildMemoryContextBlock } from "./memory.js";

// Which repositories a ticket needs is decided here, from the code — not from a
// [backend]/[frontend] tag in the title. The tag only ever said what whoever filed the
// ticket guessed: a ticket tagged for one repo was implemented in that repo alone, even
// when the feature could not work without a matching change in the other (the old
// redirect could only swap one repo for the other, never say "both").
//
// One read-only analysis turn per repo, in parallel. Each turn plans ITS repo's part
// but can also read the other repo, because "does the frontend need a change" usually
// hinges on what the backend already exposes, and the reverse. A turn that finds
// nothing to do in its repo answers with a single "ИЗМЕНЕНИЯ: НЕ НУЖНЫ" line instead of
// a plan; the repos that came back with a plan are the task's scope.

export type RepoScope = RepoKind | "cross";

export interface RepoVerdict {
  needsChanges: boolean;
  plan: string;
  // One plain sentence for the CEO — the proposal's "что сделаю" line. Empty when the
  // model didn't write one; the proposal then falls back to the plan's first sentences.
  summary: string;
  acceptanceCriteria: string[];
  // Why this repo is out of scope — only set when needsChanges is false.
  reason?: string;
  costUsd: number;
}

export interface ScopeAnalysis {
  // null: both turns found nothing to change. The caller must not start work.
  scope: RepoScope | null;
  plan: string;
  summary: string;
  acceptanceCriteria: string[];
  costUsd: number;
  // One line per repo left out of scope, for the human-visible proposal.
  skippedRepos: Array<{ repo: RepoKind; reason: string }>;
}

const REPO_LABEL: Record<RepoKind, string> = { backend: "бэкенд", frontend: "фронтенд" };
const OTHER: Record<RepoKind, RepoKind> = { backend: "frontend", frontend: "backend" };

// Must start a line: the phrase inside a sentence of an ordinary plan ("изменения в
// схеме не нужны") must never be read as "this repo is out of scope". Any line, not
// just the first — seen live (XEN-632): the model wrote a paragraph of reasoning and
// only then the signal line, and the whole answer was taken for a plan, putting a
// backend-only fix in scope for the frontend too.
const NO_CHANGES_SIGNAL = /^[ \t]*изменения\s*:\s*не\s+нужны(?![а-яё])[ \t.:—–-]*([^\n]*)/im;
const CRITERIA_SECTION = /^[ \t]*критерии\s+при[её]мки\s*:?/im;

// A real plan (it has a criteria section) wins over a stray signal line inside it.
export function parseNoChangesSignal(text: string): string | null {
  if (CRITERIA_SECTION.test(text)) return null;
  const match = NO_CHANGES_SIGNAL.exec(text);
  if (!match) return null;
  return match[1].trim() || "причина не указана";
}

// Seen live (XEN-632): reasoning notes written before "ПЛАН:" ended up at the top of
// the plan the human approves. Everything before the last "ПЛАН:" line is dropped.
export function stripPreamble(text: string): string {
  const labels = [...text.matchAll(/^[ \t]*план\s*:/gim)];
  return labels.length ? text.slice(labels[labels.length - 1].index) : text;
}

export interface ScopeOptions {
  // The human already decided this repo needs changes (the "🛠 Сделать в …" button after
  // an analysis that found nothing, or a chat instruction): only this repo is analysed,
  // and the "nothing to change" answer is not on offer.
  forceRepo?: RepoKind;
  // The human's own words on what to do — outranks the model's reading of the ticket.
  note?: string;
}

export function buildScopePrompt(
  task: TaskSpec,
  thisRepo: RepoKind,
  otherRepoPath: string,
  memoryContext: string,
  opts: { forced?: boolean; note?: string } = {},
): string {
  const other = OTHER[thisRepo];
  const optOut = opts.forced
    ? [
        `Руководитель уже решил, что в ${thisRepo} изменения НУЖНЫ — предыдущий анализ ответил «менять`,
        "нечего», и это решение его не устроило. Ответ «ИЗМЕНЕНИЯ: НЕ НУЖНЫ» не принимается. Пройди по",
        "КАЖДОМУ действию из тикета и найди по коду, где оно на самом деле не закрыто (какой эндпоинт,",
        "метод или экран его пропускает и при каком условии), и спланируй, как это закрыть.",
      ]
    : [
        `Если в ${thisRepo} менять нечего — ответь РОВНО одной строкой, без ПЛАН/КРИТЕРИИ:`,
        "ИЗМЕНЕНИЯ: НЕ НУЖНЫ — <одно предложение: что именно здесь уже есть или почему задача этого репозитория не касается>",
      ];
  return [
    `Задача ${task.id}: ${task.title}`,
    "",
    task.description,
    opts.note ? `\nУКАЗАНИЕ РУКОВОДИТЕЛЯ (важнее твоего прочтения тикета, выполнить обязательно):\n${opts.note}\n` : "",
    memoryContext ? `\n${memoryContext}\n` : "",
    "Не редактируй и не создавай файлы — только изучи код (Read/Grep/Glob).",
    "",
    `Продукт состоит из двух репозиториев. Ты отвечаешь за ${thisRepo} (${REPO_LABEL[thisRepo]}) — это`,
    `текущая директория. Второй, ${other} (${REPO_LABEL[other]}), лежит в ${otherRepoPath} — его можно`,
    "читать, чтобы понять, что там уже есть, но план ты пишешь только по своему.",
    "Теги вида [backend]/[frontend] в заголовке не учитывай — решай по коду.",
    "",
    `Сначала определи: нужно ли менять ${thisRepo}, чтобы задача заработала целиком, от`,
    "интерфейса до данных? Проверь стык двух репозиториев по коду, а не по догадке: есть",
    "ли уже нужный эндпоинт, поле, тип, параметр, вызов — и совпадает ли контракт с тем,",
    "что ожидает вторая сторона.",
    "",
    ...optOut,
    "",
    `Если менять нужно — опиши только часть ${thisRepo}; вторую половину отдельно`,
    "проанализируют и сделают по второму репозиторию. Ответь строго в этом формате, на русском:",
    "",
    "КОРОТКО: <одно предложение для руководителя, до 20 слов: что появится или исправится —",
    "без путей к файлам, имён классов и кода; пример: «добавлю на бэкенде список активных клиентов",
    "с фильтрами и сводкой по модулям»>",
    "",
    "ПЛАН:",
    "<2-4 коротких предложения: в чём проблема и что именно ты планируешь изменить в этом репозитории;",
    "если на стыке меняется контракт — назови его точно (путь, поля, типы)>",
    "",
    "КРИТЕРИИ ПРИЁМКИ:",
    "- <конкретный, проверяемый критерий>",
    "- <ещё один>",
    "(3-7 критериев — что именно должно стать верным в этом репозитории, чтобы его часть",
    "считалась сделанной; формулируй так, чтобы по каждому можно было однозначно сказать да или нет)",
  ].join("\n");
}

const SUMMARY_LINE = /^[ \t]*коротко\s*:\s*(.+)$/im;

export function parseRepoVerdict(text: string, costUsd: number): RepoVerdict {
  const reason = parseNoChangesSignal(text);
  if (reason !== null) return { needsChanges: false, plan: "", summary: "", acceptanceCriteria: [], reason, costUsd };
  // Seen live: the model mirrors the opt-out line with an "ИЗМЕНЕНИЯ: НУЖНЫ" of its own
  // before the plan. Not asked for, and it would otherwise open the plan shown to the human.
  const summary = SUMMARY_LINE.exec(text)?.[1].replace(/^[«"\s]+|[»".\s]+$/g, "") ?? "";
  const { plan, acceptanceCriteria } = parseProposalResponse(stripPreamble(text.replace(/^\s*изменения\s*:\s*нужны[^\n]*\n+/i, "")));
  return { needsChanges: true, plan, summary, acceptanceCriteria, costUsd };
}

// Both repos in scope: plan and criteria carry the "[backend]"/"[frontend]" prefixes
// queue.ts's splitCrossRepoCriteria() splits back apart at dispatch — the same flat
// shape a cross-repo proposal has always travelled in.
export function combineVerdicts(backend: RepoVerdict, frontend: RepoVerdict): ScopeAnalysis {
  const costUsd = backend.costUsd + frontend.costUsd;
  if (backend.needsChanges && frontend.needsChanges) {
    return {
      scope: "cross",
      plan: `[backend]\n${backend.plan}\n\n[frontend]\n${frontend.plan}`,
      summary: backend.summary && frontend.summary ? `бэкенд — ${backend.summary}; фронтенд — ${frontend.summary}` : "",
      acceptanceCriteria: [
        ...backend.acceptanceCriteria.map((c) => `[backend] ${c}`),
        ...frontend.acceptanceCriteria.map((c) => `[frontend] ${c}`),
      ],
      costUsd,
      skippedRepos: [],
    };
  }
  const verdicts: Record<RepoKind, RepoVerdict> = { backend, frontend };
  const skippedRepos = (["backend", "frontend"] as const)
    .filter((repo) => !verdicts[repo].needsChanges)
    .map((repo) => ({ repo, reason: verdicts[repo].reason ?? "причина не указана" }));
  const only = backend.needsChanges ? "backend" : frontend.needsChanges ? "frontend" : null;
  if (!only) return { scope: null, plan: "", summary: "", acceptanceCriteria: [], costUsd, skippedRepos };
  return {
    scope: only,
    plan: verdicts[only].plan,
    summary: verdicts[only].summary,
    acceptanceCriteria: verdicts[only].acceptanceCriteria,
    costUsd,
    skippedRepos,
  };
}

async function analyzeRepo(task: TaskSpec, repo: RepoKind, opts: { forced?: boolean; note?: string } = {}): Promise<RepoVerdict> {
  const repoPath = config.repos[repo].path;
  const otherPath = config.repos[OTHER[repo]].path;
  const memoryContext = buildMemoryContextBlock(await readMemoryFiles(repoPath, "pm"), "pm");
  const turn = await runClaudeTurn({
    cwd: repoPath,
    addDirs: [otherPath],
    prompt: buildScopePrompt(task, repo, otherPath, memoryContext, opts),
    permissionMode: "acceptEdits",
    disallowedToolsOverride: "Bash,Edit,Write,MultiEdit",
    model: config.models.propose,
  });
  // A turn that died (limit, budget, crash) has no verdict at all. Reading its empty
  // text as "a plan" would put this repo in scope with nothing to do; reading it as "no
  // changes" would silently drop half the task. Neither — the analysis fails loudly.
  if (turn.isError || !turn.resultText.trim()) {
    throw new Error(`анализ ${repo} не состоялся: ${turn.resultText.trim().slice(0, 300) || turn.terminalReason || "пустой ответ"}`);
  }
  return parseRepoVerdict(turn.resultText, turn.totalCostUsd);
}

export async function analyzeRepoScope(task: TaskSpec, opts: ScopeOptions = {}): Promise<ScopeAnalysis> {
  if (opts.forceRepo) {
    const forced = await analyzeRepo(task, opts.forceRepo, { forced: true, note: opts.note });
    const left: RepoVerdict = {
      needsChanges: false,
      plan: "",
      summary: "",
      acceptanceCriteria: [],
      reason: `по твоему решению задача делается только в ${opts.forceRepo}`,
      costUsd: 0,
    };
    return opts.forceRepo === "backend" ? combineVerdicts(forced, left) : combineVerdicts(left, forced);
  }
  const [backend, frontend] = await Promise.all([
    analyzeRepo(task, "backend", { note: opts.note }),
    analyzeRepo(task, "frontend", { note: opts.note }),
  ]);
  return combineVerdicts(backend, frontend);
}
