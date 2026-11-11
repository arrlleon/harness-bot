import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getLiveState, setPendingHumanReview, HARNESS_STATE_DIR } from "../bot/liveState.js";

// Mechanical, LLM-free bookkeeping: a runCloseLoop in flight has real work sitting
// uncommitted in its worktree on disk, but nothing survives a process restart to say
// *which* worktree/branch that in-flight task even was — currentJob (liveState.ts)
// is deliberately not persisted since "there's no running process to resume", but
// the worktree itself IS something to recover, not just an orphaned directory.
// One file per in-flight issue, written after every iteration and deleted the moment
// runCloseLoop returns (success, failure, or thrown) — so a leftover file on disk at
// startup specifically means "the process died mid-iteration", nothing else.
export interface Checkpoint {
  issueKey: string;
  title: string;
  // Carried along so a checkpoint recovered after a crash can still generate the same
  // testingNotes/closeReport attachment a normal close would — without this, a
  // crash-recovered needs_human had no way to reconstruct the real task context, only
  // the bare title.
  description: string;
  acceptanceCriteria: string[];
  branchName: string;
  worktreeDir: string;
  gitlabProjectPath: string;
  iteration: number;
  maxIterations: number;
  costUsd: number;
  phase: string;
  savedAt: string;
}

const CHECKPOINT_DIR = join(HARNESS_STATE_DIR, "checkpoints");

function pathFor(issueKey: string): string {
  return join(CHECKPOINT_DIR, `${issueKey}.json`);
}

export function writeCheckpoint(cp: Checkpoint): void {
  mkdirSync(CHECKPOINT_DIR, { recursive: true });
  writeFileSync(pathFor(cp.issueKey), JSON.stringify(cp, null, 2));
}

export function clearCheckpoint(issueKey: string): void {
  const p = pathFor(issueKey);
  if (existsSync(p)) unlinkSync(p);
}

function listCheckpoints(): Checkpoint[] {
  if (!existsSync(CHECKPOINT_DIR)) return [];
  const out: Checkpoint[] = [];
  for (const file of readdirSync(CHECKPOINT_DIR)) {
    if (!file.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(readFileSync(join(CHECKPOINT_DIR, file), "utf8")) as Checkpoint);
    } catch {
      // Corrupt/half-written file (crashed mid-write) — ignore rather than block startup.
    }
  }
  return out;
}

function describeCheckpoint(cp: Checkpoint): string {
  return `process restarted mid-run (was at iteration ${cp.iteration}/${cp.maxIterations}, phase "${cp.phase}")`;
}

export interface RecoveredCheckpoint {
  checkpoint: Checkpoint;
  reason: string;
}

// Called once at bot startup, after loadPersistedPending(). Any checkpoint still on
// disk at this point means the process died between iterations last run — rather than
// silently leave that worktree orphaned, fold it into the existing pendingHumanReview
// flow (same accept/reject diff review a normal max_iterations outcome gets) so no
// real work is ever just lost to a crash. Returns what it recovered, for the caller
// to announce.
export function recoverOrphanedCheckpoints(): RecoveredCheckpoint[] {
  const recovered: RecoveredCheckpoint[] = [];
  for (const cp of listCheckpoints()) {
    const live = getLiveState();
    // Don't clobber a pendingApproval/pendingHumanReview/pendingBrief that's already in
    // place for this exact issue (e.g. the checkpoint is stale from an older, already-
    // resolved run) — leave it for a human to sort out rather than guess.
    if (
      live.pendingApproval?.issueKey === cp.issueKey ||
      live.pendingHumanReview?.issueKey === cp.issueKey ||
      live.pendingBrief?.issueKey === cp.issueKey
    ) {
      continue;
    }
    // One review slot. A second interrupted task used to overwrite the first here
    // (its checkpoint already deleted) — leave it on disk instead; the bot calls this
    // again once the current review is resolved.
    if (live.pendingHumanReview) continue;
    const reason = describeCheckpoint(cp);
    setPendingHumanReview({
      issueKey: cp.issueKey,
      title: cp.title,
      reason,
      costUsd: cp.costUsd,
      worktreeDir: cp.worktreeDir,
      branchName: cp.branchName,
      gitlabProjectPath: cp.gitlabProjectPath,
      description: cp.description,
      acceptanceCriteria: cp.acceptanceCriteria,
    });
    clearCheckpoint(cp.issueKey);
    recovered.push({ checkpoint: cp, reason });
  }
  return recovered;
}
