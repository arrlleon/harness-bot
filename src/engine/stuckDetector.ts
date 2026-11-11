import { createHash } from "node:crypto";
import type { GateResult } from "../types.js";

// Digits collapsed to '#' before hashing: a line number or failure count shifting by
// one between two edits shouldn't mask "this is the exact same error" as "progress
// was made" — and the reverse matters just as much: hashing the FULL raw output would
// almost never repeat exactly across two real `claude` turns (timestamps, whitespace,
// incidental reordering), so it would never actually catch a stuck loop.
function normalizeLine(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\d+/g, "#").trim();
}

// Lines that actually describe a failure. The first few lines of a gate's output used
// to stand in for this, but they're usually a banner — `yarn run v1.22`, `$ jest …`,
// the scoped-test script's own "scoping to …" line — identical between two completely
// different failures, which made two consecutive DIFFERENT test failures look "stuck".
const FAILURE_LINE = /error|fail|✕|●|expected|received|cannot |not found|is not |exception|TS\d+|assert/i;
const LINES_PER_GATE = 12;

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
      const all = g.output.split("\n").map(normalizeLine).filter(Boolean);
      const relevant = all.filter((l) => FAILURE_LINE.test(l));
      // Nothing recognisable as a failure line — fall back to the whole (bounded)
      // output rather than its banner.
      const lines = (relevant.length > 0 ? relevant : all).slice(0, LINES_PER_GATE);
      return `${g.name}:${lines.join("|")}`;
    });
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16);
}
