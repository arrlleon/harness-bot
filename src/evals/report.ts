import type { EvalSuiteResult } from "./types.js";

// Plain-text table, no dependency — this runs from the CLI, not the bot.
export function formatSuiteReport(result: EvalSuiteResult): string {
  const rows = result.cases.map((c) => {
    const status = c.passed ? "PASS" : "FAIL";
    const gates = c.gateResults.map((g) => `${g.name}:${g.passed ? "ok" : "FAIL"}`).join(" ") || "(none ran)";
    return [
      status.padEnd(4),
      c.caseId.padEnd(10),
      `$${c.costUsd.toFixed(4)}`.padEnd(9),
      `${c.iterations}it`.padEnd(5),
      `${(c.durationMs / 1000).toFixed(0)}s`.padEnd(6),
      c.stopReason.padEnd(16),
      gates,
    ].join(" ");
  });

  const summary = [
    "",
    `${result.passCount}/${result.totalCount} passed, model=${result.model}, total cost $${result.totalCostUsd.toFixed(4)}`,
  ].join("\n");

  return [rows.join("\n"), summary].join("\n");
}
