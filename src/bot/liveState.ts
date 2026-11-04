import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CostEstimate } from "./state.js";

// Overridable so tests (and checkpoint.ts, which shares this directory) can point at a
// throwaway location instead of ever touching the real bot's persisted state on disk.
export const HARNESS_STATE_DIR = process.env.HARNESS_STATE_DIR ?? fileURLToPath(new URL("../../.harness-state/", import.meta.url));

export type JobPhase =
  | "transitioning"
  | "writing_acceptance_test"
  | "baseline"
  | "iterating"
  | "verifying"
  | "checking_gate_integrity"
  | "reviewing"
  | "writing_testing_notes"
  | "updating_memory"
  | "pushing"
  | "opening_mr"
  | "commenting";

export interface LiveJob {
  issueKey: string;
  title: string;
  description: string;
  repo: string;
  phase: JobPhase;
  iteration: number;
  maxIterations: number;
  costUsd: number;
  startedAt: string;
  lastTurnSummary: string;
  logs: string[];
}

const MAX_LOG_LINES = 300;

export interface PendingApproval {
  issueKey: string;
  title: string;
  repo: string;
  description: string; // full, for dispatch
  descriptionShort: string; // truncated, for display
  plan: string;
  // Fixed here, at propose time, and never regenerated or edited afterward — the
  // close loop (implement) only ever reads these for prompt context, it has no path
  // to change them. The human approves (or rejects) exactly this list before any
  // code gets written, same spirit as Avengers Harness's frozen-acceptance-tests idea.
  acceptanceCriteria: string[];
  costUsd: number;
  // Rough historical baseline (same-repo if there's enough of it, else overall) shown
  // alongside the proposal so approving isn't a blind bet — null if there's no usable
  // history yet (e.g. a fresh install, or this repo's very first task).
  costEstimate: CostEstimate | null;
}

// A close-loop that ran out of iterations (or couldn't push/open an MR) still leaves
// real, possibly-correct work sitting uncommitted in its worktree — XEN-364 reproduced
// this live: a verified-by-hand-afterwards fix that the loop itself gave up on. Rather
// than silently discarding it, a human gets to look at the diff and decide.
export interface PendingHumanReview {
  issueKey: string;
  title: string;
  reason: string;
  costUsd: number;
  worktreeDir: string;
  branchName: string;
  gitlabProjectPath: string;
}

export interface LiveState {
  botRunning: boolean;
  currentJob: LiveJob | null;
  pendingApproval: PendingApproval | null;
  pendingHumanReview: PendingHumanReview | null;
}

const state: LiveState = { botRunning: false, currentJob: null, pendingApproval: null, pendingHumanReview: null };

// currentJob isn't persisted: it tracks a live `claude` child process, which a restart
// kills regardless — there's nothing meaningful to resume it from. pendingApproval and
// pendingHumanReview are pure data with no running process behind them (the analysis
// turn, or the close loop, already finished) — losing those to a restart was a real
// problem (XEN-364: a verified, pushed fix sitting one click from an MR, with nothing
// in the bot's memory to say so) and there's no reason they can't survive one.
interface PersistedPending {
  pendingApproval: PendingApproval | null;
  pendingHumanReview: PendingHumanReview | null;
}

const PENDING_STATE_PATH = join(HARNESS_STATE_DIR, "pending-state.json");

function persistPending(): void {
  const payload: PersistedPending = { pendingApproval: state.pendingApproval, pendingHumanReview: state.pendingHumanReview };
  mkdirSync(dirname(PENDING_STATE_PATH), { recursive: true });
  writeFileSync(PENDING_STATE_PATH, JSON.stringify(payload, null, 2));
}

// Called once at bot startup, before any command can run, so a restored
// pendingApproval/pendingHumanReview is in place before /status or a stale button
// click could see a wrong "nothing pending" answer.
export function loadPersistedPending(): PersistedPending {
  if (!existsSync(PENDING_STATE_PATH)) return { pendingApproval: null, pendingHumanReview: null };
  try {
    const parsed = JSON.parse(readFileSync(PENDING_STATE_PATH, "utf8")) as Partial<PersistedPending>;
    state.pendingApproval = parsed.pendingApproval ?? null;
    state.pendingHumanReview = parsed.pendingHumanReview ?? null;
  } catch {
    // Corrupt or half-written file — start clean rather than crash the bot over it.
  }
  return { pendingApproval: state.pendingApproval, pendingHumanReview: state.pendingHumanReview };
}

export function setPendingApproval(p: PendingApproval): void {
  state.pendingApproval = p;
  persistPending();
}

export function clearPendingApproval(): void {
  state.pendingApproval = null;
  persistPending();
}

export function setPendingHumanReview(p: PendingHumanReview): void {
  state.pendingHumanReview = p;
  persistPending();
}

export function clearPendingHumanReview(): void {
  state.pendingHumanReview = null;
  persistPending();
}

export function getLiveState(): LiveState {
  return state;
}

export function setBotRunning(running: boolean): void {
  state.botRunning = running;
}

export function startJob(issueKey: string, title: string, description: string, repo: string, maxIterations: number): void {
  state.currentJob = {
    issueKey,
    title,
    description,
    repo,
    phase: "transitioning",
    iteration: 0,
    maxIterations,
    costUsd: 0,
    startedAt: new Date().toISOString(),
    lastTurnSummary: "",
    logs: [],
  };
}

export function updateJob(patch: Partial<LiveJob>): void {
  if (!state.currentJob) return;
  Object.assign(state.currentJob, patch);
}

export function appendLog(line: string): void {
  if (!state.currentJob) return;
  state.currentJob.logs.push(line);
  if (state.currentJob.logs.length > MAX_LOG_LINES) {
    state.currentJob.logs.splice(0, state.currentJob.logs.length - MAX_LOG_LINES);
  }
}

export function finishJob(): void {
  state.currentJob = null;
}
