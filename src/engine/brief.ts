import type { Brief } from "../types.js";

// Modeled directly on ETS Tender's own production "брифы": a structured question with
// concrete options and a recommendation, answered with one click — not a free-text
// question the harness would have to interpret, and not silent guessing either.
// Appended to the implement prompts (prompts.ts) so it's always available, not a
// separate turn — raising one costs nothing extra, it's just a different shape of
// response to the same turn.
export function buildBriefInstructions(): string {
  return [
    "If something about this task is genuinely ambiguous — a requirement that could",
    "reasonably mean two different things, a decision with real consequences you're not",
    "confident about — do NOT guess and proceed. Stop and respond with EXACTLY this",
    "format instead of making any further edits:",
    "",
    "БРИФ",
    "ВОПРОС: <the question, in Russian, one or two sentences>",
    "ВАРИАНТЫ:",
    "1. <option>",
    "2. <option>",
    "(as many options as make sense, at least 2)",
    "РЕКОМЕНДАЦИЯ: <number of the option you'd pick, or НЕТ if you have no preference>",
    "ПОЧЕМУ: <one or two sentences — your reasoning for the recommendation>",
    "",
    "Only do this for genuine ambiguity, not routine implementation choices you're",
    "equipped to make yourself — a brief interrupts a human, so it costs their time.",
  ].join("\n");
}

const BRIEF_HEADING = /^БРИФ\s*$/im;
const QUESTION_LINE = /ВОПРОС:\s*(.+)/i;
const OPTIONS_HEADING = /ВАРИАНТЫ:?/i;
const OPTION_LINE = /^\s*\d+[.)]\s+(.+)$/gm;
const RECOMMENDATION_LINE = /РЕКОМЕНДАЦИЯ:\s*(\d+|НЕТ)/i;
const RATIONALE_LINE = /ПОЧЕМУ:\s*([\s\S]+?)(?:\n\n|$)/i;

// Fails closed, same philosophy as parseReviewResponse: if the model didn't actually
// follow the format, this returns null and the turn is treated as a normal response
// (whatever code it wrote still gets verified) rather than the harness guessing at a
// half-formed brief.
export function parseBrief(text: string): Brief | null {
  if (!BRIEF_HEADING.test(text)) return null;

  const questionMatch = QUESTION_LINE.exec(text);
  if (!questionMatch) return null;

  const optionsIdx = text.search(OPTIONS_HEADING);
  if (optionsIdx === -1) return null;
  // Bounded to [ВАРИАНТЫ:, РЕКОМЕНДАЦИЯ:) rather than to end-of-text — otherwise a
  // numbered list inside ПОЧЕМУ's own rationale text would get swept in as options.
  const recIdx = text.search(RECOMMENDATION_LINE);
  const optionsEnd = recIdx !== -1 && recIdx > optionsIdx ? recIdx : undefined;
  const optionsSection = text.slice(optionsIdx, optionsEnd);
  const options = [...optionsSection.matchAll(OPTION_LINE)].map((m) => ({ label: m[1].trim() }));
  if (options.length < 2) return null;

  const recMatch = RECOMMENDATION_LINE.exec(text);
  const recommendedIndex =
    recMatch && recMatch[1].toUpperCase() !== "НЕТ" ? Number(recMatch[1]) - 1 : undefined;
  const validRecommendedIndex =
    recommendedIndex !== undefined && recommendedIndex >= 0 && recommendedIndex < options.length ? recommendedIndex : undefined;

  const rationaleMatch = RATIONALE_LINE.exec(text);

  return {
    question: questionMatch[1].trim(),
    options,
    recommendedIndex: validRecommendedIndex,
    rationale: rationaleMatch ? rationaleMatch[1].trim() : undefined,
  };
}

// Flattens a brief into one line of plain text — for contexts with no buttons (Jira
// comments, the cross-repo needs_human fallback in queue.ts) where the question still
// needs to be legible, just without the one-click affordance Telegram gives it.
export function formatBriefAsText(brief: Brief): string {
  const options = brief.options
    .map((o, i) => `${i + 1}. ${o.label}${brief.recommendedIndex === i ? " ★" : ""}`)
    .join("; ");
  const rationale = brief.rationale ? ` (${brief.rationale})` : "";
  return `${brief.question} Варианты: ${options}${rationale}`;
}

// What the paused session sees once the human picks an option — resumed via the same
// sessionId (CloseLoopResumeState), so this only needs to hand over the answer, not
// re-explain the whole task.
export function buildBriefAnswerPrompt(brief: Brief, chosenIndex: number): string {
  const chosen = brief.options[chosenIndex];
  return [
    `CEO ответил на твой вопрос: «${brief.question}»`,
    `Выбрал: ${chosen.label}`,
    "",
    "Продолжай работу с учётом этого ответа.",
  ].join("\n");
}
