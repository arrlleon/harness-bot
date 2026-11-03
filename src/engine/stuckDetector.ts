import { createHash } from "node:crypto";
import type { GateResult } from "../types.js";

// Digits collapsed to '#' before hashing: a line number or failure count shifting by
// one between two edits shouldn't mask "this is the exact same error" as "progress
// was made" — and the reverse matters just as much: hashing the FULL raw output would
// almost never repeat exactly across two real `claude` turns (timestamps, whitespace,
// incidental reordering), so it would never actually catch a stuck loop. Only the
// first few lines of each gate's output are used — that's where the actual error
// message/stack lives; later lines are usually noise (full stdout dumps, etc.).
function normalizeLine(line: string): string {
  return line.replace(/\d+/g, "#").trim();
}

const LINES_PER_GATE = 3;

// A stable signature for "what's currently broken" — same signature twice in a row
// means the agent's last edit didn't change the nature of the failure at all, which
// is a much stronger "not making progress" signal than just "still failing" (the
// agent could legitimately fix one error and uncover a different one, which should
// NOT count as stuck).
export function fingerprintFailure(failedGates: GateResult[]): string {
  const parts = failedGates
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((g) => {
      const lines = g.output.split("\n").map(normalizeLine).filter(Boolean).slice(0, LINES_PER_GATE);
      return `${g.name}:${lines.join("|")}`;
    });
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16);
}
