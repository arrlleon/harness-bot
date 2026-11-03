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
    timestamp: new Date().toISOString(),
  });
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
