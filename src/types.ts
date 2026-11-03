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
  // Internal to the eval harness (evals/runCase.ts): when set, runCloseLoop uses this
  // worktree as-is instead of creating its own from repoPath/branchName — lets an eval
  // case check out a specific historical commit and pre-stage the hidden test commit
  // before the loop's own baseline ever runs, while reusing the entire rest of the
  // production iteration/budget/stuck-detector/commit pipeline unchanged.
  existingWorktreeDir?: string;
  // Present only when the task has frozen acceptance criteria to turn into an
  // executable gate. Absent (e.g. non-reviewed dispatch paths) means no acceptance
  // test is written and the loop behaves exactly as it did before this existed.
  acceptanceTest?: { model: string; runner: string; ext: string };
  // Absent disables the whole memory layer (no read injected into prompts, no write
  // attempted on success) — same opt-out shape as acceptanceTest.
  memory?: { model: string; baseBranch: string };
  // Absent disables independent review entirely (no extra turn, no review_blocked
  // outcome possible) — same opt-out shape as acceptanceTest/memory.
  review?: { model: string; baseBranch: string };
  // Absent disables the manual-testing-notes turn — same opt-out shape as
  // acceptanceTest/memory/review. Never blocks anything (unlike review): it's purely
  // informational output for a human tester, surfaced in the Jira success comment.
  testingNotes?: { model: string; baseBranch: string };
  onIteration?: (info: {
    iteration: number;
    phase: "baseline" | "writing_acceptance_test" | "iterating" | "verifying" | "reviewing" | "writing_testing_notes" | "updating_memory";
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
  | {
      kind: "needs_human";
      issueKey: string;
      costUsd: number;
      reason: string;
      worktreeDir: string;
      branchName: string;
      durationMs: number;
      repo: string;
    }
  | { kind: "closed"; issueKey: string; costUsd: number; mrUrl: string; durationMs: number; repo: string };

export interface CloseLoopResult {
  task: TaskSpec;
  success: boolean;
  iterations: CloseLoopIteration[];
  totalCostUsd: number;
  stopReason: "verified" | "max_iterations" | "max_budget" | "agent_error" | "stuck" | "review_blocked";
  worktreeDir: string;
  // Set only when stopReason is "stuck" — the gate(s) whose failure fingerprint
  // repeated identically across two consecutive iterations, for diagnostics in the
  // Jira comment / Telegram needs_human message.
  stuckGates?: string[];
  // Set when an acceptance test was successfully written and frozen into the loop as
  // a gate; absent if none was requested, or the write attempt failed (see onLog for
  // why — the loop still proceeds without it rather than failing the whole task).
  acceptanceTestPath?: string;
  // True only if the memory turn judged something durable happened and actually wrote
  // a commit for it — most successful tasks won't have anything worth recording.
  memoryUpdated?: boolean;
  // Set whenever review ran, success or not — a blocking finding flips success to
  // false (stopReason "review_blocked", routed through the existing needs_human flow,
  // same as any other failure); nonblocking findings ride along even on a real success,
  // for the MR description/Jira comment.
  reviewFindings?: ReviewFinding[];
  // Set whenever the testing-notes turn ran and produced non-empty output — a plain
  // Предусловия/Шаги/Ожидаемый результат write-up for a human tester, surfaced in the
  // Jira success comment. Absent if the turn was disabled, errored, or came back empty.
  testingNotes?: string;
}

export interface ReviewFinding {
  blocking: boolean;
  description: string;
}
