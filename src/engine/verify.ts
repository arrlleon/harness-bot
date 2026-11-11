import { spawn } from "node:child_process";
import type { GateBaseline, GateResult, GateSpec, VerifyResult } from "../types.js";
import { buildAgentEnv } from "./claudeEngine.js";
import { signalChild, trackTaskChild } from "./processRegistry.js";

// A gate that couldn't actually run (ran out of memory, hung past its timeout, drowned
// its own output buffer) says nothing about the code under test. Thrown rather than
// reported as a normal gate failure: the agent can't fix it by editing files, and
// treating it as "the gate was red" is exactly how a crashed baseline used to turn a
// gate into a permanent pass (see compareGate).
export class GateInfraError extends Error {}

const DEFAULT_GATE_TIMEOUT_MS = 30 * 60_000;
const GATE_HEAP_MB = 4096;

function gateTimeoutMs(): number {
  const configured = Number(process.env.GATE_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_GATE_TIMEOUT_MS;
}

// Gates run the repo's own code (tests the agent itself may have written), and their
// output goes straight back into the agent's next prompt — so they get the same
// secret-stripped env the `claude` child does. NODE_OPTIONS raises the heap: reproduced
// live (XEN-540) that `tsc --noEmit` on back-ai dies with "JavaScript heap out of
// memory" at Node's default limit on this machine.
export function gateEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = buildAgentEnv(source);
  const existing = env.NODE_OPTIONS ?? "";
  if (!/--max-old-space-size/.test(existing)) {
    env.NODE_OPTIONS = `${existing} --max-old-space-size=${GATE_HEAP_MB}`.trim();
  }
  return env;
}

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

const KILLED_BY_HUMAN = "остановлен вручную (/kill)";

interface RawRun {
  exitedZero: boolean;
  output: string;
  // Set when the command itself didn't get to do its job — see GateInfraError.
  crash?: string;
}

// Pure so the classification is testable without spawning anything.
export function classifyCrash(exit: { timedOut?: boolean; signal?: string | null }, output: string, timeoutMs: number): string | undefined {
  if (exit.timedOut) return `не завершился за ${Math.round(timeoutMs / 60_000)} мин и был остановлен`;
  // SIGTERM is /kill (processRegistry.ts); the timeout above uses SIGKILL.
  if (exit.signal === "SIGTERM") return KILLED_BY_HUMAN;
  if (/JavaScript heap out of memory|FATAL ERROR: .*Allocation failed/.test(output)) return "не хватило памяти (JavaScript heap out of memory)";
  return undefined;
}

const MAX_GATE_OUTPUT_CHARS = 32 * 1024 * 1024;

// spawn + its own process group rather than exec: exec's timeout and kill only ever
// reach the `sh -c` wrapper, so a hung `yarn test` kept its jest workers alive (and the
// gate "timed out" while still burning CPU). Output past the cap is dropped, not
// treated as a failure of the gate.
function runRaw(cwd: string, command: string): Promise<RawRun> {
  const timeoutMs = gateTimeoutMs();
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], { cwd, env: gateEnv(), detached: true, stdio: ["ignore", "pipe", "pipe"] });
    trackTaskChild(child, { group: true });
    let raw = "";
    let timedOut = false;
    const collect = (chunk: Buffer): void => {
      if (raw.length < MAX_GATE_OUTPUT_CHARS) raw += chunk.toString("utf8");
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const timer = setTimeout(() => {
      timedOut = true;
      signalChild(child, "SIGKILL", true);
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitedZero: false, output: err.message, crash: `не удалось запустить: ${err.message}` });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const output = stripAnsi(raw);
      if (code === 0) return resolve({ exitedZero: true, output });
      resolve({ exitedZero: false, output, crash: classifyCrash({ timedOut, signal }, output, timeoutMs) });
    });
  });
}

// One retry: memory pressure on a dev machine is transient often enough that a second
// attempt is worth it before giving up on the whole task.
async function runGateCommand(cwd: string, gate: GateSpec): Promise<RawRun> {
  let run = await runRaw(cwd, gate.command);
  if (run.crash && run.crash !== KILLED_BY_HUMAN) run = await runRaw(cwd, gate.command);
  if (run.crash) {
    throw new GateInfraError(`гейт "${gate.name}" не смог отработать: ${run.crash}. Это проблема окружения, а не кода задачи.\n${run.output.slice(-600)}`);
  }
  return run;
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
  // `nest build` / `tsc -b`: "Found N error(s)." when present, else the TS error count.
  // Without this a build that was already red at baseline (back-ai: 8 pre-existing
  // errors) could never be compared and was permanently waved through.
  build: (output) => {
    const found = output.match(/Found (\d+) errors?/i);
    if (found) return Number(found[1]);
    const matches = output.match(/error TS\d+:/g);
    return matches ? matches.length : null;
  },
};

export function parseFailureCount(gateName: string, output: string): number | null {
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
export async function establishBaselines(cwd: string, gates: GateSpec[], onLog?: (line: string) => void): Promise<GateBaseline[]> {
  const baselines: GateBaseline[] = [];
  for (const gate of gates) {
    // A strict gate (the acceptance test; optionally the diff-scoped test gate —
    // see config.ts's `${prefix}_TEST_STRICT`) never consults its baseline at all
    // (runGates below branches on `gate.strict` before even looking), so running one
    // here was pure wasted work.
    if (gate.strict) continue;
    const { exitedZero, output } = await runGateCommand(cwd, gate);
    const failureCount = parseFailureCount(gate.name, output);
    if (!exitedZero && failureCount === null) {
      // Not an error — some gates genuinely have no countable output — but it does mean
      // this gate can't tell "still broken the same way" from "broken worse" for the
      // rest of the task, and a human should know that going in.
      onLog?.(`⚠️ Гейт "${gate.name}" красный ещё до правок и его вывод не поддаётся подсчёту — для этой задачи он не сможет отличить новую поломку от старой.`);
    }
    baselines.push({ name: gate.name, command: gate.command, exitedZero, failureCount });
  }
  return baselines;
}

export function compareGate(gate: GateSpec, baseline: GateBaseline, exitedZero: boolean, output: string): boolean {
  if (exitedZero) return true;
  const failureCount = parseFailureCount(gate.name, output);
  // Can't count-compare when either side's output doesn't match the expected
  // summary format — fall back to the baseline's own exit code rather than risk
  // calling a real regression "no new failures" by accident, but also rather than
  // blocking forever on a gate that was already red before the agent touched anything.
  if (baseline.failureCount !== null && failureCount !== null) {
    return failureCount <= baseline.failureCount;
  }
  // The baseline was countable and this run isn't: the gate is now failing in a way it
  // wasn't before (a syntax error that stops the tool before its normal summary, say).
  if (baseline.failureCount !== null) return false;
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
    const { exitedZero, output } = await runGateCommand(cwd, gate);
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
