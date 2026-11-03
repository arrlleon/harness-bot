export interface TaskSpec {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
}

export interface GateSpec {
  name: string;
  command: string;
  // Baseline-relative gates (typecheck/lint/test/build) pass if they're no worse than
  // before the agent's edit — correct for pre-existing repo noise, but wrong for an
  // acceptance test: it's brand new, there is no "before" to tolerate, it must
  // actually pass. A strict gate ignores its baseline and requires exit 0 outright.
  strict?: boolean;
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
  // Present only when the task has frozen acceptance criteria to turn into an
  // executable gate. Absent (e.g. non-reviewed dispatch paths) means no acceptance
  // test is written and the loop behaves exactly as it did before this existed.
  acceptanceTest?: { model: string; runner: string; ext: string };
  onIteration?: (info: {
    iteration: number;
    phase: "baseline" | "writing_acceptance_test" | "iterating" | "verifying";
    costUsd: number;
    summary: string;
  }) => void;
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
  // Set when an acceptance test was successfully written and frozen into the loop as
  // a gate; absent if none was requested, or the write attempt failed (see onLog for
  // why — the loop still proceeds without it rather than failing the whole task).
  acceptanceTestPath?: string;
}
