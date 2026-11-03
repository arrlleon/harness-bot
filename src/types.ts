export interface TaskSpec {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
}

export interface GateSpec {
  name: string;
  command: string;
}

export interface GateBaseline {
  name: string;
  command: string;
  exitedZero: boolean;
  failureCount: number | null;
}

export interface GateResult {
  name: string;
  command: string;
  passed: boolean;
  output: string;
}

export interface EngineConfig {
  repoPath: string;
  branchName: string;
  gates: GateSpec[];
  maxIterations: number;
  maxBudgetUsd: number;
  permissionMode: string;
  model?: string;
  extraDeniedPaths?: string[];
  onIteration?: (info: { iteration: number; phase: "baseline" | "iterating" | "verifying"; costUsd: number; summary: string }) => void;
  onLog?: (line: string) => void;
}

export interface ClaudeTurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export interface ClaudeTurnResult {
  sessionId: string;
  resultText: string;
  isError: boolean;
  terminalReason: string;
  totalCostUsd: number;
  usage: ClaudeTurnUsage;
}

export interface VerifyResult {
  passed: boolean;
  output: string;
  gates: GateResult[];
}

export interface CloseLoopIteration {
  turn: ClaudeTurnResult;
  verify: VerifyResult;
}

export type QueueRunOutcome =
  | { kind: "empty" }
  | { kind: "paused"; reason: string }
  | { kind: "busy"; issueKey: string }
  | { kind: "skipped"; issueKey: string; reason: string }
  | { kind: "needs_human"; issueKey: string; costUsd: number; reason: string; worktreeDir: string; branchName: string }
  | { kind: "closed"; issueKey: string; costUsd: number; mrUrl: string };

export interface CloseLoopResult {
  task: TaskSpec;
  success: boolean;
  iterations: CloseLoopIteration[];
  totalCostUsd: number;
  stopReason: "verified" | "max_iterations" | "max_budget" | "agent_error";
  worktreeDir: string;
}
