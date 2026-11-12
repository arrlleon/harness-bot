import { config } from "./config.js";
import { autoFixNeedsHuman, canAutoFix, isPushFailure, resolveBrief, resolveHumanReview } from "./queue.js";
import { getLiveState } from "./bot/liveState.js";
import { explainStop, headline } from "./bot/messages.js";
import type { QueueRunOutcome } from "./types.js";

// Once a plan is approved, the bot takes the task to an MR on its own: a question the
// agent raises is answered with the agent's own recommended option, and a stop is fed
// back through "🛠 Решить самому" — up to AUTOPILOT_MAX_FIXES times and within
// AUTOPILOT_TASK_CAP_USD for the whole task. Only when that runs out does a decision
// reach the human, with the usual buttons. The approval of the plan itself stays
// manual (decided 2026-11-12: XEN-381's analysis misread the frontend contract, and
// the plan is where a human catches that).

const MAX_AUTO_ANSWERS = 5;

export interface AutopilotHooks {
  // Every intermediate outcome is recorded here (history and daily budget); the last
  // one is returned for the caller to handle as it always has.
  record(outcome: QueueRunOutcome): void;
  notify(text: string): Promise<unknown>;
}

export function pickBriefOption(brief: { options: unknown[]; recommendedIndex?: number }): number {
  const i = brief.recommendedIndex;
  return i !== undefined && i >= 0 && i < brief.options.length ? i : 0;
}

// The decision part, separate from the side effects so it can be tested: whether the
// next stop gets another automatic attempt.
export function shouldAutoFix(
  pending: { reason: string; costUsd: number; resumeState?: unknown },
  fixesSoFar: number,
  limits: { maxFixes: number; taskCapUsd: number },
): boolean {
  if (fixesSoFar >= limits.maxFixes) return false;
  if (!canAutoFix(pending)) return false;
  // A push/MR retry costs nothing; an agent run needs money left under the cap.
  return isPushFailure(pending.reason) || pending.costUsd < limits.taskCapUsd - 1;
}

export async function driveToEnd(first: QueueRunOutcome | null, hooks: AutopilotHooks): Promise<QueueRunOutcome | null> {
  let outcome = first;
  if (!config.autopilot.enabled) return outcome;
  let fixes = 0;
  let answers = 0;
  while (outcome) {
    if (outcome.kind === "brief_pending") {
      const pending = getLiveState().pendingBrief;
      // An agent that keeps asking is not converging — past a handful, the human decides.
      if (!pending || answers >= MAX_AUTO_ANSWERS) break;
      answers++;
      const index = pickBriefOption(pending.brief);
      hooks.record(outcome);
      await hooks.notify(
        [
          `${headline("question", pending.issueKey)} — ответил сам`,
          pending.brief.question,
          "",
          `Выбрал: ${pending.brief.options[index]?.label ?? `вариант ${index + 1}`}${pending.brief.recommendedIndex === index ? " (рекомендация агента)" : ""}`,
          "Продолжаю работу.",
        ].join("\n"),
      );
      outcome = await resolveBrief(index);
      continue;
    }
    if (outcome.kind === "needs_human") {
      const pending = getLiveState().pendingHumanReview;
      if (!pending || !shouldAutoFix(pending, fixes, { maxFixes: config.autopilot.maxFixes, taskCapUsd: config.autopilot.taskCapUsd })) {
        if (fixes > 0 && pending) {
          await hooks.notify(`${headline("decision", pending.issueKey)}\nСам пробовал исправить ${fixes} раз(а) — не вышло. Нужно твоё решение, сообщение с кнопками ниже.`);
        }
        break;
      }
      fixes++;
      hooks.record(outcome);
      await hooks.notify(
        [
          headline("working", pending.issueKey),
          `Остановился: ${explainStop(pending.reason).why}`,
          `Исправляю сам — ${explainStop(pending.reason).fix} (попытка ${fixes} из ${config.autopilot.maxFixes}).`,
        ].join("\n"),
      );
      outcome = isPushFailure(pending.reason) ? await retryPush() : await autoFixNeedsHuman({ capUsd: config.autopilot.taskCapUsd });
      continue;
    }
    break;
  }
  return outcome;
}

// A push/MR failure is fixed by retrying the push; resolveHumanReview reports through
// its own shape, so the retry is mapped back to an outcome here.
async function retryPush(): Promise<QueueRunOutcome | null> {
  const pending = getLiveState().pendingHumanReview;
  try {
    const result = await resolveHumanReview(true);
    if (result && "mrUrl" in result) {
      return {
        kind: "closed",
        issueKey: result.issueKey,
        mrUrl: result.mrUrl,
        costUsd: result.costUsd,
        costAlreadyRecordedUsd: result.costUsd,
        durationMs: 0,
        repo: result.repo,
      } as QueueRunOutcome;
    }
  } catch {
    // resolveHumanReview restores the pending review on failure.
  }
  const still = getLiveState().pendingHumanReview;
  return still && pending
    ? ({
        kind: "needs_human",
        issueKey: still.issueKey,
        costUsd: still.costUsd,
        costAlreadyRecordedUsd: still.costUsd,
        reason: still.reason,
        worktreeDir: still.worktreeDir,
        branchName: still.branchName,
        durationMs: 0,
        repo: still.gitlabProjectPath,
      } as QueueRunOutcome)
    : null;
}
