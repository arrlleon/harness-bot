import type { ReviewFinding } from "../types.js";

// A reviewer can see the problem and still file it under ЗАМЕЧАНИЯ. Reproduced live
// (XEN-1025, MR 860): the review wrote that the author's download is "новое поведение,
// а не только фикс подписанта ... фактически доступ расширен", guessed it was
// intentional and left it nonblocking, so the task went to a merge request that reopened
// what TASK-113 and XEN-541 had closed. Widened access or behaviour the ticket didn't ask
// for is exactly what a human has to decide on, whatever the reviewer's guess.
//
// Matched on the wording a finding uses for that, not on the topic: "доступ ко всему
// документу" is a description of what the code does, "доступ расширен" is a verdict.
const SCOPE_OR_ACCESS_CHANGE = new RegExp(
  [
    String.raw`доступ\S*\s+(?:\S+\s+)?расширен`,
    String.raw`расширя\S*\s+(?:права|доступ)`,
    String.raw`расширени\S*\s+(?:прав|доступа)`,
    String.raw`ослабл\S*\s+(?:защит|провер|прав)`,
    String.raw`эскалаци\S*\s+(?:прав|привилег)`,
    String.raw`новое поведение`,
    String.raw`не только фикс`,
    String.raw`(?:вне|за) рамк\S*\s+задач`,
    String.raw`не входит в задачу`,
    String.raw`privilege escalation`,
    String.raw`widen\S*\s+(?:the\s+)?(?:access|permission)`,
    String.raw`out of scope`,
    String.raw`beyond the (?:ticket|task)`,
  ].join("|"),
  "i",
);

export const ESCALATION_NOTE = "[блокирует: расширение прав или поведение вне задачи — решает человек]";

// Nonblocking findings that describe widened access or behaviour outside the ticket
// become blocking, marked so the loop can stop on them (see needsHumanDecision).
export function escalateScopeFindings(findings: ReviewFinding[]): ReviewFinding[] {
  return findings.map((f) =>
    !f.blocking && SCOPE_OR_ACCESS_CHANGE.test(f.description)
      ? { blocking: true, description: `${ESCALATION_NOTE} ${f.description}` }
      : f,
  );
}

// An escalated finding stops the task for a human instead of going to a fix round. Both
// times this happened (XEN-1023, XEN-1025) the widening came from a frozen acceptance
// criterion the developer is not allowed to change, so fix rounds could only burn
// budget arguing with the test; whether the criterion or the code is wrong is the
// human's call.
// The same goes for a blocking finding the reviewer itself hands to a human: a dispute
// it keeps after the developer's reply ([СПОР], see review.ts) or any finding that says
// a person must decide. XEN-1111 ran two more rounds on such a finding — the reviewer
// wrote "решать должен человек" and the loop sent it back to the developer anyway.
const HUMAN_DECIDES = /^\s*\[СПОР\]|реша(?:ет|ть|ю)\s+(?:\S+\s+){0,2}человек|(?:принимает|принять|примет)\s+(?:\S+\s+){0,2}человек|human (?:should|must|has to) decide/i;

export function needsHumanDecision(blocking: ReviewFinding[]): boolean {
  return blocking.some((f) => f.description.startsWith(ESCALATION_NOTE) || HUMAN_DECIDES.test(f.description));
}
