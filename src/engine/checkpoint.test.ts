import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// HARNESS_STATE_DIR is read once at module-load time (liveState.ts), so it has to be
// set BEFORE that module is first evaluated — static imports are hoisted ahead of any
// in-file code, so this file uses dynamic import() after setting the env var instead,
// pointed at a throwaway directory. Never touches the real bot's .harness-state/.
let checkpoint: typeof import("./checkpoint.js");
let liveState: typeof import("../bot/liveState.js");
let stateDir: string;

before(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "jira-harness-checkpoint-test-"));
  process.env.HARNESS_STATE_DIR = stateDir;
  checkpoint = await import("./checkpoint.js");
  liveState = await import("../bot/liveState.js");
});

after(async () => {
  delete process.env.HARNESS_STATE_DIR;
  await rm(stateDir, { recursive: true, force: true });
});

function sampleCheckpoint(issueKey: string) {
  return {
    issueKey,
    title: "Fix the thing",
    branchName: `harness/${issueKey.toLowerCase()}`,
    worktreeDir: "/tmp/does-not-need-to-exist-for-this-test",
    gitlabProjectPath: "saqr/back-ai",
    iteration: 2,
    maxIterations: 5,
    costUsd: 0.42,
    phase: "iterating",
    savedAt: new Date().toISOString(),
  };
}

test("writeCheckpoint then clearCheckpoint round-trips cleanly", () => {
  const cp = sampleCheckpoint("XEN-100");
  checkpoint.writeCheckpoint(cp);
  assert.ok(existsSync(join(stateDir, "checkpoints", "XEN-100.json")));
  checkpoint.clearCheckpoint("XEN-100");
  assert.equal(existsSync(join(stateDir, "checkpoints", "XEN-100.json")), false);
});

test("clearCheckpoint on a non-existent issue is a no-op, not an error", () => {
  assert.doesNotThrow(() => checkpoint.clearCheckpoint("XEN-does-not-exist"));
});

test("recoverOrphanedCheckpoints converts an orphaned checkpoint into pendingHumanReview", () => {
  liveState.clearPendingApproval();
  liveState.clearPendingHumanReview();
  const cp = sampleCheckpoint("XEN-101");
  checkpoint.writeCheckpoint(cp);

  const recovered = checkpoint.recoverOrphanedCheckpoints();

  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].checkpoint.issueKey, "XEN-101");
  assert.match(recovered[0].reason, /process restarted mid-run/);
  assert.match(recovered[0].reason, /2\/5/);

  const pending = liveState.getLiveState().pendingHumanReview;
  assert.ok(pending);
  assert.equal(pending?.issueKey, "XEN-101");
  assert.equal(pending?.worktreeDir, cp.worktreeDir);
  assert.equal(pending?.gitlabProjectPath, cp.gitlabProjectPath);

  // The checkpoint file itself is consumed — pendingHumanReview now owns this worktree.
  assert.equal(existsSync(join(stateDir, "checkpoints", "XEN-101.json")), false);

  liveState.clearPendingHumanReview();
});

test("recoverOrphanedCheckpoints skips an issue that already has a pendingHumanReview", () => {
  liveState.clearPendingApproval();
  liveState.setPendingHumanReview({
    issueKey: "XEN-102",
    title: "Already being reviewed",
    reason: "max_iterations",
    costUsd: 1.0,
    worktreeDir: "/tmp/already-set",
    branchName: "harness/xen-102",
    gitlabProjectPath: "saqr/back-ai",
  });
  checkpoint.writeCheckpoint(sampleCheckpoint("XEN-102"));

  const recovered = checkpoint.recoverOrphanedCheckpoints();

  assert.equal(recovered.length, 0);
  // Didn't clobber the existing (presumably more authoritative) pendingHumanReview.
  assert.equal(liveState.getLiveState().pendingHumanReview?.worktreeDir, "/tmp/already-set");
  // Left the stale checkpoint file alone rather than guessing what to do with it.
  assert.ok(existsSync(join(stateDir, "checkpoints", "XEN-102.json")));

  checkpoint.clearCheckpoint("XEN-102");
  liveState.clearPendingHumanReview();
});

test("recoverOrphanedCheckpoints skips an issue that already has a pendingApproval", () => {
  liveState.clearPendingHumanReview();
  liveState.setPendingApproval({
    issueKey: "XEN-103",
    title: "Awaiting approval",
    repo: "backend",
    description: "full description",
    descriptionShort: "short",
    plan: "the plan",
    costUsd: 0.1,
  });
  checkpoint.writeCheckpoint(sampleCheckpoint("XEN-103"));

  const recovered = checkpoint.recoverOrphanedCheckpoints();

  assert.equal(recovered.length, 0);
  assert.equal(liveState.getLiveState().pendingHumanReview, null);

  checkpoint.clearCheckpoint("XEN-103");
  liveState.clearPendingApproval();
});

test("recoverOrphanedCheckpoints returns nothing when no checkpoints are on disk", () => {
  liveState.clearPendingApproval();
  liveState.clearPendingHumanReview();
  assert.deepEqual(checkpoint.recoverOrphanedCheckpoints(), []);
});
