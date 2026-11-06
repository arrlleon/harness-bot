import type { EvalCaseAggregate, EvalSuiteResult } from "./types.js";

// At k=1 (the default) this reads exactly like the old single-attempt report: one row
// per case, its one attempt's own stopReason/gates. At k>1, the row becomes the
// AGGREGATE (pass rate, total cost across attempts) and each attempt gets its own
// indented line below — the per-attempt detail isn't thrown away, just demoted below
// the number that actually answers "did this case pass".
function formatCaseRow(c: EvalCaseAggregate, k: number): string {
  const passedCount = c.attempts.filter((a) => a.passed).length;
  const status = c.passAtK ? "PASS" : "FAIL";
  const header =
    k === 1
      ? formatAttemptLine(status, c.caseId, c.attempts[0])
      : [
          status.padEnd(4),
          c.caseId.padEnd(10),
          `${passedCount}/${k}`.padEnd(6),
          `$${c.totalCostUsd.toFixed(4)}`.padEnd(9),
          `pass@1=${c.passAtOneRate.toFixed(2)}`,
        ].join(" ");

  if (k === 1) return header;
  const attemptLines = c.attempts.map((a, i) => "    " + formatAttemptLine(a.passed ? "PASS" : "FAIL", `#${i + 1}`, a));
  return [header, ...attemptLines].join("\n");
}

function formatAttemptLine(status: string, label: string, a: EvalCaseAggregate["attempts"][number]): string {
  const gates = a.gateResults.map((g) => `${g.name}:${g.passed ? "ok" : "FAIL"}`).join(" ") || "(none ran)";
  return [
    status.padEnd(4),
    label.padEnd(10),
    `$${a.costUsd.toFixed(4)}`.padEnd(9),
    `${a.iterations}it`.padEnd(5),
    `${(a.durationMs / 1000).toFixed(0)}s`.padEnd(6),
    a.stopReason.padEnd(16),
    gates,
  ].join(" ");
}

// Plain-text table, no dependency — this runs from the CLI, not the bot.
export function formatSuiteReport(result: EvalSuiteResult): string {
  const rows = result.cases.map((c) => formatCaseRow(c, result.k));

  const summary =
    result.k === 1
      ? `${result.passAtKCount}/${result.totalCount} passed, model=${result.model}, total cost $${result.totalCostUsd.toFixed(4)}`
      : [
          `pass@1 (mean over ${result.k} runs/case): ${(result.passAtOneRate * 100).toFixed(0)}%`,
          `pass^${result.k} (every run passed): ${result.passAtKCount}/${result.totalCount}`,
          `model=${result.model}, total cost $${result.totalCostUsd.toFixed(4)}`,
        ].join("\n");

  return [rows.join("\n"), "", summary].join("\n");
}
