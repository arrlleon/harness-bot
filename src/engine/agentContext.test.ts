import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Same reasoning as checkpoint.test.ts: HARNESS_STATE_DIR is read once at module-load
// time (liveState.ts), so this uses a dynamic import() after setting the env var,
// pointed at a throwaway directory — never touches the real bot's .harness-state/.
let agentContext: typeof import("./agentContext.js");
let stateDir: string;

before(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "jira-harness-agent-context-test-"));
  process.env.HARNESS_STATE_DIR = stateDir;
  agentContext = await import("./agentContext.js");
});

after(async () => {
  delete process.env.HARNESS_STATE_DIR;
  await rm(stateDir, { recursive: true, force: true });
});

test("writeTaskContext writes a file under tasks/<issueKey>/<role>/", async () => {
  agentContext.writeTaskContext("XEN-1", "reviewer", "round-1.md", "БЛОКИРУЮЩИЕ:\n- проблема");
  const content = await readFile(join(stateDir, "tasks", "XEN-1", "reviewer", "round-1.md"), "utf8");
  assert.equal(content, "БЛОКИРУЮЩИЕ:\n- проблема");
});

test("writeTaskContext keeps different roles for the same task in separate directories", async () => {
  agentContext.writeTaskContext("XEN-2", "reviewer", "round-1.md", "reviewer's note");
  agentContext.writeTaskContext("XEN-2", "dev", "round-1-response.md", "dev's note");
  const reviewerNote = await readFile(join(stateDir, "tasks", "XEN-2", "reviewer", "round-1.md"), "utf8");
  const devNote = await readFile(join(stateDir, "tasks", "XEN-2", "dev", "round-1-response.md"), "utf8");
  assert.equal(reviewerNote, "reviewer's note");
  assert.equal(devNote, "dev's note");
});

test("writeTaskContext overwrites a file with the same name rather than appending", async () => {
  agentContext.writeTaskContext("XEN-3", "reviewer", "round-1.md", "first");
  agentContext.writeTaskContext("XEN-3", "reviewer", "round-1.md", "second");
  const content = await readFile(join(stateDir, "tasks", "XEN-3", "reviewer", "round-1.md"), "utf8");
  assert.equal(content, "second");
});
