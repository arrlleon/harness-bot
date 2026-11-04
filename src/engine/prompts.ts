import type { GateResult, TaskSpec } from "../types.js";
import { buildBriefInstructions } from "./brief.js";

// memoryContext (from engine/memory.ts) is injected directly rather than left for the
// agent to discover on its own — it's not auto-loaded by the project's own CLAUDE.md
// (only AGENTS.md is), so without this the agent would only see it if it happened to
// read those files unprompted.
export function buildInitialPrompt(task: TaskSpec, memoryContext = "", briefsEnabled = true): string {
  const criteria = task.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n");
  return [
    `Task ${task.id}: ${task.title}`,
    "",
    task.description,
    "",
    "Acceptance criteria:",
    criteria,
    memoryContext ? `\n${memoryContext}\n` : "",
    "Implement this fully in the current repository by editing files directly.",
    "Follow the project's existing conventions. You do not have shell access in",
    "this session and should not attempt to run commands; a separate process",
    "will run tests and commit your changes. Stop once the files are correct.",
    briefsEnabled ? `\n${buildBriefInstructions()}` : "",
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
