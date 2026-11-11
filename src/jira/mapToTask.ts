import type { TaskSpec } from "../types.js";
import type { RepoKind } from "../config.js";
import type { JiraIssue } from "./client.js";

export type RepoDetection = { kind: RepoKind } | { kind: "ambiguous" } | { kind: "unknown" };

function tagsIn(text: string): RepoDetection {
  const haystack = text.toLowerCase();
  const hasBackend = haystack.includes("[backend]");
  const hasFrontend = haystack.includes("[frontend]") || haystack.includes("[web]");
  if (hasBackend && hasFrontend) return { kind: "ambiguous" };
  if (hasBackend) return { kind: "backend" };
  if (hasFrontend) return { kind: "frontend" };
  return { kind: "unknown" };
}

// The title decides when it carries a tag at all; the description is only consulted
// for an untagged title. They used to be read as one string, so a ticket retagged
// `[backend]` in its title (retagTitle below only ever rewrites the title) but still
// mentioning `[web]` somewhere in its description came back "ambiguous" at dispatch —
// routed down the cross-repo path, where every criterion without a repo prefix is
// dropped and both halves ran with no acceptance criteria at all.
export function detectRepo(issue: JiraIssue): RepoDetection {
  const fromTitle = tagsIn(issue.summary);
  return fromTitle.kind !== "unknown" ? fromTitle : tagsIn(issue.description);
}

export function toTaskSpec(issue: JiraIssue): TaskSpec {
  return {
    id: issue.key,
    title: issue.summary,
    description: issue.description,
    acceptanceCriteria: [],
  };
}

const REPO_TAG_NAME: Record<RepoKind, string> = { backend: "[backend]", frontend: "[frontend]" };
const ANY_REPO_TAG = /\[(backend|frontend|web)\]\s*/gi;

// A tag mismatch (ticket tagged [frontend], real fix is backend-only — reproduced live,
// XEN-541) isn't a reason to stop and ask a human: the harness just picked the wrong
// repo to read, not an unsolvable ambiguity. queue.ts's proposeIssue re-analyzes
// against `correctRepo` once a propose turn says so, and uses THIS retagged title —
// not a fresh Jira fetch — for both the human-visible summary (so nobody else trips
// over the same stale tag) and the in-memory one detectRepo will see again at dispatch
// time (confirmPending reconstructs the issue from PendingApproval.title): both have to
// agree, or approving the proposal would silently route back to the wrong repo.
// Strips EVERY existing tag rather than just the wrong one — a stray leftover
// "[frontend] [backend] ..." would make this ticket "ambiguous" again on the next read.
export function retagTitle(title: string, correctRepo: RepoKind): string {
  const stripped = title.replace(ANY_REPO_TAG, "").trim();
  return `${REPO_TAG_NAME[correctRepo]} ${stripped}`;
}
