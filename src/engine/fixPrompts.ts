import type { GateResult, TaskSpec } from "../types.js";
import { buildContinuationPrompt } from "./prompts.js";

// The first prompt of a "🛠 Решить самому" run (queue.ts autoFixNeedsHuman): the usual
// fresh-session continuation (task, criteria, diff so far, failing gates) plus one
// paragraph saying what actually stopped the previous attempt and what to do about it.
// Keyed on the leading code of the needs_human reason (see queue.ts buildFailureReason).
export function stopGuidance(reason: string, conflictedFiles: string[] = []): string {
  const r = reason.replace(/^(backend|frontend): /, "");
  if (r.startsWith("rebase_conflict")) {
    return [
      "WHAT STOPPED THE PREVIOUS ATTEMPT: the target branch moved on while this task was paused.",
      "The harness has now merged the fresh target branch into this branch. These files were",
      "left with git conflict markers (<<<<<<<, =======, >>>>>>>):",
      ...conflictedFiles.map((f) => `- ${f}`),
      "Resolve every marker by keeping BOTH sides' intent — the target branch's new changes and",
      "this task's work — then make sure the task still meets its acceptance criteria. No",
      "conflict marker may remain anywhere.",
    ].join("\n");
  }
  if (r.startsWith("review_blocked")) {
    const findings = r.replace(/^review_blocked[^:]*:\s*/, "");
    return [
      "WHAT STOPPED THE PREVIOUS ATTEMPT: the independent code review blocked the change.",
      "Blocking findings:",
      findings,
      "Fix each of them in the code. If one is genuinely wrong, leave a short code comment",
      "where it applies explaining why, instead of silently ignoring it.",
    ].join("\n");
  }
  if (r.startsWith("gate_integrity_violation")) {
    return [
      "WHAT STOPPED THE PREVIOUS ATTEMPT: it weakened the verification itself (" + r.replace(/^gate_integrity_violation:\s*/, "") + ").",
      "Restore every test, test config and type-check config to how the target branch has them,",
      "then make the real code satisfy them. Never skip, delete or loosen a check.",
    ].join("\n");
  }
  if (r.startsWith("stuck") || r.startsWith("max_iterations")) {
    return [
      "WHAT STOPPED THE PREVIOUS ATTEMPT: it kept failing the same verification and ran out of",
      "attempts. Its approach did not work — do not repeat it. Read the failing output below",
      "carefully, find the actual cause, and fix that.",
    ].join("\n");
  }
  if (r.startsWith("max_budget")) {
    return "WHAT STOPPED THE PREVIOUS ATTEMPT: it ran out of budget before finishing. Finish the remaining work; do not redo what is already correct.";
  }
  return "WHAT STOPPED THE PREVIOUS ATTEMPT: it was interrupted before finishing. Finish the remaining work; do not redo what is already correct.";
}

export function buildAutoFixPrompt(
  task: TaskSpec,
  reason: string,
  diff: string,
  briefsEnabled: boolean,
  failedGates: GateResult[] = [],
  conflictedFiles: string[] = [],
): string {
  return [stopGuidance(reason, conflictedFiles), "", buildContinuationPrompt(task, diff, briefsEnabled, failedGates)].join("\n");
}
