import type { TaskSpec } from "../types.js";
import type { RepoKind } from "../config.js";
import type { JiraIssue } from "./client.js";

export type RepoDetection = { kind: RepoKind } | { kind: "ambiguous" } | { kind: "unknown" };

export function detectRepo(issue: JiraIssue): RepoDetection {
  const haystack = `${issue.summary} ${issue.description}`.toLowerCase();
  const hasBackend = haystack.includes("[backend]");
  const hasFrontend = haystack.includes("[frontend]") || haystack.includes("[web]");
  if (hasBackend && hasFrontend) return { kind: "ambiguous" };
  if (hasBackend) return { kind: "backend" };
  if (hasFrontend) return { kind: "frontend" };
  return { kind: "unknown" };
}

export function toTaskSpec(issue: JiraIssue): TaskSpec {
  return {
    id: issue.key,
    title: issue.summary,
    description: issue.description,
    acceptanceCriteria: [],
  };
}
