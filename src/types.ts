export interface TaskSpec {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
}

// "Brief": a structured question an agent raises instead of guessing at genuine
// ambiguity — concrete options, not free text, so the human answers with one click
// (Telegram buttons) rather than typing a reply the harness would have to interpret.
// Modeled directly on ETS Tender's own production "брифы" (10-15/day, one-click
// answers) rather than invented from scratch.
export interface BriefOption {
  label: string;
}

export interface Brief {
  question: string;
  options: BriefOption[];
  // Index into options — absent if the agent genuinely had no preference.
  recommendedIndex?: number;
  rationale?: string;
}

// Captures exactly what's needed to resume runCloseLoop's iteration loop from the
// middle, after a pause for a brief answer — not a full re-run (which would redo
// baseline establishment and acceptance-test writing against a worktree that already
// has partial work in it, and would be flatly wrong once any iteration has happened).
// Deliberately has no prompt field: at pause time the answer doesn't exist yet — only
// resolveBrief (queue.ts), once the human has actually picked an option, knows it.
export interface CloseLoopResumeState {
  sessionId: string;
  iteration: number;
  totalCostUsd: number;
  gates: GateSpec[];
  baselines: GateBaseline[];
  extraDeniedPaths?: string[];
  acceptanceTestPath?: string;
  previousFingerprint?: string;
}

// Every turn is one of these — used both for per-role project memory
// (.claude/memory/jira-harness/<role>.md) and per-task scratch
// (.harness-state/tasks/<ISSUE-KEY>/<role>/). Deliberately a closed set, not a bare
// string: a typo in a role name would silently start a new, orphaned memory file
// nobody ever reads again.
export type AgentRole = "pm" | "dev" | "reviewer";

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
  // A resumed session's quality degrades well before the model's real context window
  // fills — checked against input+cache_read+cache_creation tokens from the latest
  // turn (the real total the model saw, not a per-turn delta). Absent/zero disables
  // the check entirely.
  maxContextTokens?: number;
  permissionMode: string;
  model?: string;
  extraDeniedPaths?: string[];
  // Internal to the eval harness (evals/runCase.ts): when set, runCloseLoop uses this
  // worktree as-is instead of creating its own from repoPath/branchName — lets an eval
  // case check out a specific historical commit and pre-stage the hidden test commit
  // before the loop's own baseline ever runs, while reusing the entire rest of the
  // production iteration/budget/stuck-detector/commit pipeline unchanged.
  existingWorktreeDir?: string;
  // Present when this call is resuming after a brief was answered — skips acceptance-
  // test writing, baseline establishment, and memory reading (all already done before
  // the pause) and picks the iteration loop back up with `prompt` (the human's answer,
  // via buildBriefAnswerPrompt) as the next turn. Absent on every normal (first) call.
  resumeFrom?: CloseLoopResumeState & { prompt: string };
  // Default true (undefined counts as enabled) — same opt-out shape as the other
  // optional behaviors, even though this one costs nothing extra on its own.
  briefsEnabled?: boolean;
  // Present only when the task has frozen acceptance criteria to turn into an
  // executable gate. Absent (e.g. non-reviewed dispatch paths) means no acceptance
  // test is written and the loop behaves exactly as it did before this existed.
  acceptanceTest?: { model: string; runner: string; ext: string };
  // Absent disables the whole memory layer (no read injected into prompts, no write
  // attempted on success) — same opt-out shape as acceptanceTest.
  memory?: { model: string; baseBranch: string };
  // Absent disables independent review entirely (no extra turn, no review_blocked
  // outcome possible) — same opt-out shape as acceptanceTest/memory. maxRounds caps
  // the reviewer<->developer back-and-forth (same session, review finds a blocking
  // issue -> dev fixes it -> gates re-run -> review again) — required, not optional:
  // an uncapped negotiation between two agents that might never agree has to have a
  // hard stop, same reasoning as maxIterations for the gate-fixing loop.
  review?: { model: string; baseBranch: string; maxRounds: number };
  // Absent disables the manual-testing-notes turn — same opt-out shape as
  // acceptanceTest/memory/review. Never blocks anything (unlike review): it's purely
  // informational output for a human tester, surfaced in the Jira success comment.
  testingNotes?: { model: string; baseBranch: string };
  // Absent disables the mechanical gate-integrity check — same opt-out shape as the
  // other optional stages, but this one costs no extra LLM turn (pure diff parsing),
  // so there's little reason to ever turn it off outside of debugging it.
  gateIntegrityCheck?: { baseBranch: string };
  onIteration?: (info: {
    iteration: number;
    phase:
      | "baseline"
      | "writing_acceptance_test"
      | "iterating"
      | "verifying"
      | "checking_gate_integrity"
      | "reviewing"
      | "writing_testing_notes"
      | "updating_memory";
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
  // The agent genuinely isn't sure and raised a brief instead of guessing — distinct
  // from needs_human (which means something went wrong); this just means a decision
  // is needed before work can continue. durationMs/repo omitted on purpose: unlike
  // needs_human/closed, this isn't a final outcome — the task is still open and will
  // resume once resolveBrief() runs.
  | { kind: "brief_pending"; issueKey: string }
  | { kind: "closed"; issueKey: string; costUsd: number; mrUrl: string; durationMs: number; repo: string };

export interface CloseLoopResult {
  task: TaskSpec;
  success: boolean;
  iterations: CloseLoopIteration[];
  totalCostUsd: number;
  stopReason:
    | "verified"
    | "max_iterations"
    | "max_budget"
    | "context_budget"
    | "agent_error"
    | "stuck"
    | "review_blocked"
    | "gate_integrity_violation"
    | "brief_pending";
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
  // How many review<->fix rounds actually ran (1 if the reviewer was satisfied first
  // try). Set whenever review ran at all, success or "review_blocked" — lets a human
  // reading the needs_human reason see "it tried 3 rounds and gave up" instead of just
  // the final round's findings with no sense of how much negotiation happened.
  reviewRounds?: number;
  // Set whenever the testing-notes turn ran and produced non-empty output — a plain
  // Предусловия/Шаги/Ожидаемый результат write-up for a human tester, surfaced in the
  // Jira success comment. Absent if the turn was disabled, errored, or came back empty.
  testingNotes?: string;
  // Set only when stopReason is "gate_integrity_violation" — a mechanical check (not
  // an LLM judgment call) found the agent weakening the thing that judges it: a
  // deleted test file, a newly added skip/only/todo marker, or an edit to CI/gate
  // config. Always routes to needs_human, never retried — unlike a normal gate
  // failure, giving the agent another attempt just risks it hiding this better.
  gateIntegrityViolations?: string[];
  // Set only when stopReason is "context_budget" — the measured input+cache_read+
  // cache_creation token count that tripped maxContextTokens, for the needs_human
  // reason text.
  contextTokens?: number;
  // Both set only when stopReason is "brief_pending" — the question to put in front of
  // the human, and everything needed to resume this exact session once they answer
  // (see resolveBrief in queue.ts and CloseLoopResumeState above).
  brief?: Brief;
  resumeState?: CloseLoopResumeState;
}

export interface ReviewFinding {
  blocking: boolean;
  description: string;
}
