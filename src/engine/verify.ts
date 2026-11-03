import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { GateBaseline, GateResult, GateSpec, VerifyResult } from "../types.js";

const execAsync = promisify(exec);

async function runRaw(cwd: string, command: string): Promise<{ exitedZero: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execAsync(command, { cwd, maxBuffer: 1024 * 1024 * 20 });
    return { exitedZero: true, output: stdout + stderr };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    return { exitedZero: false, output: (e.stdout ?? "") + (e.stderr ?? "") || e.message };
  }
}

// Per-gate count parsers. A gate without one (or whose output doesn't match) falls
// back to a plain exit-code check against the gate's own baseline exit code — see
// the exitedZero fallback in compareGate below.
//
// Jest ("Tests:  N failed, ...") and Vitest ("Tests  N failed | ...") summaries both
// have a line starting with the word "Tests" — `\bTests\b` deliberately excludes
// Jest's "Test Suites:" and Vitest's "Test Files" lines, which report a DIFFERENT
// (smaller) count: one failing suite can contain several failing tests. Reproduced
// live: an unqualified `(\d+)\s+failed` matched "24 failed" from "Test Suites:"
// instead of the real "86 failed" on the "Tests:" line, understating the baseline.
const GATE_PARSERS: Record<string, (output: string) => number | null> = {
  test: (output) => {
    const match = output.match(/\bTests:?\s+(\d+)\s+failed\b/i);
    return match ? Number(match[1]) : null;
  },
  typecheck: (output) => {
    const matches = output.match(/error TS\d+:/g);
    return matches ? matches.length : null;
  },
  lint: (output) => {
    const match = output.match(/\b(\d+)\s+problems?\b/i);
    return match ? Number(match[1]) : null;
  },
};

function parseFailureCount(gateName: string, output: string): number | null {
  return GATE_PARSERS[gateName]?.(output) ?? null;
}

// Run once per gate against the freshly created worktree, before any agent edits. A
// flat "command must exit 0" check can never be satisfied in a repo that already has
// unrelated failing tests/lint errors (86 pre-existing test failures on back-ai as of
// 2026-10-29, none touching the ticket at hand) — every iteration was burning its
// budget on pre-existing failures that no fix could ever clear. Comparing against each
// gate's own pre-existing count (or, when uncountable, its own pre-existing exit code)
// means a gate that was already broken for unrelated reasons doesn't hold the agent's
// fix hostage.
export async function establishBaselines(cwd: string, gates: GateSpec[]): Promise<GateBaseline[]> {
  const baselines: GateBaseline[] = [];
  for (const gate of gates) {
    const { exitedZero, output } = await runRaw(cwd, gate.command);
    baselines.push({ name: gate.name, command: gate.command, exitedZero, failureCount: parseFailureCount(gate.name, output) });
  }
  return baselines;
}

function compareGate(gate: GateSpec, baseline: GateBaseline, exitedZero: boolean, output: string): boolean {
  if (exitedZero) return true;
  const failureCount = parseFailureCount(gate.name, output);
  // Can't count-compare when either side's output doesn't match the expected
  // summary format — fall back to the baseline's own exit code rather than risk
  // calling a real regression "no new failures" by accident, but also rather than
  // blocking forever on a gate that was already red before the agent touched anything.
  if (baseline.failureCount !== null && failureCount !== null) {
    return failureCount <= baseline.failureCount;
  }
  return !baseline.exitedZero; // gate was already failing at baseline time — not this fix's fault
}

// Runs every configured gate (doesn't stop at the first failure) and reports all of
// them together — one combined feedback prompt covering tsc+lint+test failures lets
// the agent fix everything in a single edit pass instead of burning separate
// iterations chasing one gate at a time under a tight MAX_ITERATIONS budget.
export async function runGates(cwd: string, gates: GateSpec[], baselines: GateBaseline[]): Promise<VerifyResult> {
  const results: GateResult[] = [];
  for (const gate of gates) {
    const baseline = baselines.find((b) => b.name === gate.name);
    const { exitedZero, output } = await runRaw(cwd, gate.command);
    // Strict gates never consult their baseline — a brand-new acceptance test failing
    // at baseline (no fix exists yet) is expected, not a pre-existing condition to
    // tolerate; it must actually pass now, "no worse than before" isn't good enough.
    const passed = gate.strict ? exitedZero : baseline ? compareGate(gate, baseline, exitedZero, output) : exitedZero;
    results.push({ name: gate.name, command: gate.command, passed, output });
  }
  const passed = results.every((r) => r.passed);
  const output = results
    .filter((r) => !r.passed)
    .map((r) => `[${r.name}]\n${r.output}`)
    .join("\n\n");
  return { passed, output, gates: results };
}
