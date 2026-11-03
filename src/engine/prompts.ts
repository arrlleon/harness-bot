import type { GateResult, TaskSpec } from "../types.js";

export function buildInitialPrompt(task: TaskSpec): string {
  const criteria = task.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n");
  return [
    `Task ${task.id}: ${task.title}`,
    "",
    task.description,
    "",
    "Acceptance criteria:",
    criteria,
    "",
    "Implement this fully in the current repository by editing files directly.",
    "Follow the project's existing conventions. You do not have shell access in",
    "this session and should not attempt to run commands; a separate process",
    "will run tests and commit your changes. Stop once the files are correct.",
  ].join("\n");
}

// One section per failing gate (not one combined blob) — each capped separately so
// e.g. a verbose lint failure can't crowd a short typecheck failure out of the
// agent's view. Naming the gate up front also lets the agent see immediately that
// typecheck/lint/test are independent problems, not one tangled failure.
export function buildFeedbackPrompt(failedGates: GateResult[]): string {
  const sections = failedGates
    .map((g) => `### ${g.name} (\`${g.command}\`) failed\n\n\`\`\`\n${g.output.slice(0, 4000)}\n\`\`\``)
    .join("\n\n");
  return [
    `Verification failed after your last change. ${failedGates.length} gate(s) failed:`,
    "",
    sections,
    "",
    "Fix the root cause for each failing gate by editing files, then stop.",
  ].join("\n");
}
