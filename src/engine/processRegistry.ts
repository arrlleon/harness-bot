import type { ChildProcess } from "node:child_process";

// Every child process doing paid or long-running work for the current task — `claude`
// turns and gate commands alike — so /kill can stop whatever is actually running. A
// set, not a single slot: a cross-repo proposal runs two turns at once, and with one
// slot whichever started last overwrote the other and whichever finished first cleared
// it, so /kill could answer "nothing running" while the task kept spending. Gates
// weren't tracked at all: /kill during a 30-minute test run did nothing.
const taskChildren = new Map<ChildProcess, { group: boolean }>();

// Signals the child's whole process group when it leads one (`detached: true` at spawn)
// — a gate is `sh -c "yarn test"`, and signalling only the shell leaves jest and its
// workers running.
export function signalChild(child: ChildProcess, signal: NodeJS.Signals, group: boolean): void {
  try {
    if (group && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // already gone
  }
}

export function trackTaskChild(child: ChildProcess, opts: { group?: boolean } = {}): void {
  taskChildren.set(child, { group: opts.group ?? false });
  const forget = (): void => void taskChildren.delete(child);
  child.once("close", forget);
  child.once("error", forget);
}

// SIGTERM, deliberately distinct from the SIGKILL a gate timeout uses — the gate runner
// tells "a human stopped this" from "this hung" by the signal.
export function killTaskChildren(): boolean {
  if (taskChildren.size === 0) return false;
  for (const [child, { group }] of taskChildren) signalChild(child, "SIGTERM", group);
  return true;
}
