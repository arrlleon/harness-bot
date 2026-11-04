import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { HARNESS_STATE_DIR } from "../bot/liveState.js";
import type { AgentRole } from "../types.js";

// Per-task, per-role scratch — not a channel agents read from each other. Each role
// only ever sees what's explicitly handed to it via a prompt (e.g. the reviewer's
// findings fed into the next implement turn as buildReviewFixPrompt's output); this is
// a durable audit trail for a human reading back "what happened to this ticket, role by
// role", one file per round per role, so nothing gets overwritten or blended together.
function taskRoleDir(issueKey: string, role: AgentRole): string {
  return join(HARNESS_STATE_DIR, "tasks", issueKey, role);
}

export function writeTaskContext(issueKey: string, role: AgentRole, filename: string, content: string): void {
  const dir = taskRoleDir(issueKey, role);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), content);
}
