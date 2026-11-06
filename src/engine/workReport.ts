// Composes the file attached to the Jira issue when it moves out of "In Progress" —
// from pieces ALREADY generated elsewhere in the same successful run (closeReport.ts's
// plain-language "what changed", testingNotes.ts's Предусловия/Шаги/Ожидаемый результат)
// rather than a new LLM turn: between them they already cover exactly what a tester
// needs — what changed and how to verify it — and both are already written for a
// non-technical reader, so they read as one document rather than two mismatched halves.
// Returns undefined when neither piece exists (both disabled, or both turns failed/came
// back empty) — nothing meaningful to attach.
//
// Takes just {id, title} rather than a full TaskSpec so it works the same way for a
// single-repo task and for a cross-repo one — the latter has no single TaskSpec once
// both halves are done, only the original {key, summary} the whole thing started from.
export function buildWorkReportDocument(task: { id: string; title: string }, pieces: { closeReport?: string; testingNotes?: string }): string | undefined {
  if (!pieces.closeReport && !pieces.testingNotes) return undefined;

  const sections = [`Отчёт по задаче ${task.id}: ${task.title}`, ""];
  if (pieces.closeReport) {
    sections.push("Что сделано:", pieces.closeReport, "");
  }
  if (pieces.testingNotes) {
    sections.push("Как проверить:", pieces.testingNotes, "");
  }
  return sections.join("\n").trimEnd() + "\n";
}

export function workReportFilename(issueKey: string): string {
  return `${issueKey}-report.txt`;
}
