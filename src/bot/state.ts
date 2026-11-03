import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { QueueRunOutcome } from "../types.js";

const STATE_PATH = fileURLToPath(new URL("../../.harness-state/bot-state.json", import.meta.url));

export interface TaskRecord {
  issueKey: string;
  outcome: "closed" | "needs_human" | "skipped";
  detail: string;
  costUsd: number;
  // Optional, not required: existing records in .harness-state/bot-state.json predate
  // these two fields (added for cost/time estimation) — loadState() doesn't migrate
  // old entries, so estimateCost() below has to tolerate either being absent rather
  // than assume every record has them.
  durationMs?: number;
  repo?: string;
  timestamp: string;
}

export interface BotState {
  running: boolean;
  history: TaskRecord[];
}

function defaultState(): BotState {
  return { running: false, history: [] };
}

export function loadState(): BotState {
  if (!existsSync(STATE_PATH)) return defaultState();
  try {
    return { ...defaultState(), ...JSON.parse(readFileSync(STATE_PATH, "utf8")) };
  } catch {
    return defaultState();
  }
}

export function saveState(state: BotState): void {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

export function recordTask(state: BotState, record: TaskRecord): void {
  state.history.push(record);
  saveState(state);
}

// Shared by the proposal-confirm flow and the dashboard's manual-start path —
// both end up with a QueueRunOutcome and need the same bookkeeping.
export function recordOutcome(state: BotState, outcome: QueueRunOutcome): void {
  if (outcome.kind !== "closed" && outcome.kind !== "needs_human" && outcome.kind !== "skipped") return;
  recordTask(state, {
    issueKey: outcome.issueKey,
    outcome: outcome.kind,
    detail: outcome.kind === "closed" ? outcome.mrUrl : outcome.reason,
    costUsd: "costUsd" in outcome ? outcome.costUsd : 0,
    durationMs: "durationMs" in outcome ? outcome.durationMs : undefined,
    repo: "repo" in outcome ? outcome.repo : undefined,
    timestamp: new Date().toISOString(),
  });
}

export interface CostEstimate {
  sampleSize: number;
  avgCostUsd: number;
  medianCostUsd: number;
  // Present only if at least one contributing record has a recorded duration —
  // records from before this field existed are excluded from these two, even though
  // they still count toward the cost numbers above.
  avgDurationMs: number | null;
  medianDurationMs: number | null;
}

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function average(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

// A rough historical baseline shown before approving a task, not a per-task
// prediction — "skipped" (ambiguous routing, cancelled before any real work) never
// spent anything meaningful and is excluded. Prefers same-repo history once there's
// enough of it (>= 3 samples) to be more than noise; falls back to the overall
// history otherwise, and to null (not "$0.00") when there's nothing to go on yet.
export function estimateCost(state: BotState, repo?: string): CostEstimate | null {
  const isReal = (r: TaskRecord) => (r.outcome === "closed" || r.outcome === "needs_human") && r.costUsd > 0;
  const all = state.history.filter(isReal);
  const scoped = repo ? all.filter((r) => r.repo === repo) : all;
  const pool = scoped.length >= 3 ? scoped : all;
  if (pool.length === 0) return null;

  const costs = pool.map((r) => r.costUsd).sort((a, b) => a - b);
  const durations = pool
    .map((r) => r.durationMs)
    .filter((d): d is number => typeof d === "number" && d > 0)
    .sort((a, b) => a - b);

  return {
    sampleSize: pool.length,
    avgCostUsd: average(costs),
    medianCostUsd: median(costs),
    avgDurationMs: durations.length > 0 ? average(durations) : null,
    medianDurationMs: durations.length > 0 ? median(durations) : null,
  };
}

export function totalCostUsd(state: BotState): number {
  return state.history.reduce((sum, r) => sum + r.costUsd, 0);
}

export function costSince(state: BotState, sinceIso: string): number {
  return state.history.filter((r) => r.timestamp >= sinceIso).reduce((sum, r) => sum + r.costUsd, 0);
}

export function countSince(state: BotState, sinceIso: string): number {
  return state.history.filter((r) => r.timestamp >= sinceIso).length;
}

export function startOfTodayIso(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}
