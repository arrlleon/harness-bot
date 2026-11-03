import type { GateSpec } from "../types.js";

// Deliberately excludes the repo's "test" gate (the full regression suite) — reproduced
// live this session: back-ai's full suite OOM-killed the machine twice in a row, even
// with reduced Jest worker parallelism. Eval cases are meant to be run often (every
// time a prompt/model changes), so they need to be cheap and safe to repeat, not just
// "realistic" — typecheck/build (if configured) plus the historical hidden test is
// already a strong, fast signal of whether the fix is real.
export function buildEvalGates(repoGates: GateSpec[], acceptanceRunner: string, hiddenTestPaths: string[]): GateSpec[] {
  const cheapGates = repoGates.filter((g) => g.name !== "test");
  const hiddenTestGate: GateSpec = {
    name: "hidden_test",
    command: `${acceptanceRunner} ${hiddenTestPaths.join(" ")}`,
    // Strict, not baseline-relative, for the same reason production's acceptance gate
    // is: this test is new to the agent's worktree (restored from history right before
    // baseline), there's no "pre-existing" state to tolerate — it must actually pass.
    strict: true,
  };
  return [...cheapGates, hiddenTestGate];
}
