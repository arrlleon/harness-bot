import type { RepoKind } from "../config.js";

// Splits the propose-turn's free-text response into a plan and a list of acceptance
// criteria. The model is asked to label a "КРИТЕРИИ ПРИЁМКИ:" section with one
// criterion per bulleted line — this just extracts that structure back out so the
// criteria can be stored as data (frozen in PendingApproval, never regenerated) rather
// than staying buried inside one plan string nothing downstream can act on.
const CRITERIA_HEADING = /критерии\s+при[её]мки\s*:?/i;
const PLAN_LABEL = /^план\s*:?\s*/i;
const BULLET_LINE = /^[-*•]\s+(.+)$/gm;

// Checked before the ПЛАН/КРИТЕРИИ parse above: a propose turn told to answer with
// exactly one "РЕПОЗИТОРИЙ: backend|frontend" line instead, when it finds the real fix
// belongs entirely in the OTHER repo from the one it's reading (queue.ts's prompt asks
// for this explicitly — see proposeSolution). Anchored to the start of the response: a
// mention of "backend"/"frontend" anywhere else in a normal plan must never be mistaken
// for this signal.
const WRONG_REPO_SIGNAL = /^\s*репозитори[йя]\s*:?\s*(backend|frontend)\b/i;

export function parseWrongRepoSignal(text: string): RepoKind | null {
  const match = WRONG_REPO_SIGNAL.exec(text);
  return match ? (match[1].toLowerCase() as RepoKind) : null;
}

export interface ParsedProposal {
  plan: string;
  acceptanceCriteria: string[];
}

export function parseProposalResponse(text: string): ParsedProposal {
  const match = CRITERIA_HEADING.exec(text);
  if (!match) {
    // Model didn't follow the requested format — degrade to "plan only, no frozen
    // criteria" rather than losing the whole proposal over a formatting miss.
    return { plan: text.trim(), acceptanceCriteria: [] };
  }

  const plan = text.slice(0, match.index).replace(PLAN_LABEL, "").trim();
  const criteriaSection = text.slice(match.index + match[0].length);
  const acceptanceCriteria = [...criteriaSection.matchAll(BULLET_LINE)]
    .map((m) => m[1].trim())
    .filter(Boolean);

  return { plan, acceptanceCriteria };
}
