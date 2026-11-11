#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { runCloseLoop } from "./engine/loop.js";
import { runQueueOnce } from "./queue.js";
import type { TaskSpec } from "./types.js";

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function loadTask(taskArg: string): TaskSpec {
  const trimmed = taskArg.trim();
  const isInlineJson = trimmed.startsWith("{");
  const isFile = !isInlineJson && trimmed.endsWith(".json");
  const raw = isFile ? readFileSync(resolve(trimmed), "utf8") : trimmed;
  const parsed =
    isFile || isInlineJson
      ? JSON.parse(raw)
      : { id: "adhoc", title: "Ad-hoc task", description: raw, acceptanceCriteria: [] };
  if (!parsed.id || !parsed.title || !parsed.description) {
    throw new Error("Task JSON must have id, title, description, and optionally acceptanceCriteria[]");
  }
  return {
    id: String(parsed.id),
    title: String(parsed.title),
    description: String(parsed.description),
    acceptanceCriteria: Array.isArray(parsed.acceptanceCriteria) ? parsed.acceptanceCriteria : [],
  };
}

const program = new Command();

program
  .name("jira-harness")
  .description("Single-task close loop: run Claude Code against a task until verification passes");

program
  .command("run")
  .requiredOption("--repo <path>", "Path to the target git repository")
  .requiredOption("--task <taskOrFile>", "Inline task text, or a path to a .json task file")
  .requiredOption("--verify <command>", "Shell command to run for verification (e.g. \"pnpm test\")")
  .option("--branch <name>", "Branch name to work on (default derived from task id)")
  .option("--max-iterations <n>", "Max close-loop iterations", "5")
  .option("--max-budget-usd <n>", "Max total spend in USD", "5")
  .option("--permission-mode <mode>", "Claude permission mode", "acceptEdits")
  .action(async (opts) => {
    const task = loadTask(opts.task);
    const branchName = opts.branch ?? `harness/${slugify(task.id)}-${slugify(task.title)}`;

    console.log(`[jira-harness] task=${task.id} branch=${branchName} repo=${opts.repo}`);

    // NaN here used to mean "zero iterations, report failure" with no hint why.
    const maxIterations = Number(opts.maxIterations);
    const maxBudgetUsd = Number(opts.maxBudgetUsd);
    if (!Number.isInteger(maxIterations) || maxIterations < 1 || !Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0) {
      console.error("[jira-harness] --max-iterations must be a positive integer and --max-budget-usd a positive number");
      process.exit(1);
    }

    const result = await runCloseLoop(task, {
      repoPath: resolve(opts.repo),
      branchName,
      gates: [{ name: "test", command: opts.verify }],
      maxIterations,
      maxBudgetUsd,
      permissionMode: opts.permissionMode,
    });

    for (const [i, iter] of result.iterations.entries()) {
      console.log(`\n--- iteration ${i + 1} ---`);
      console.log(`claude: ${iter.turn.resultText.slice(0, 500)}`);
      console.log(`verify: ${iter.verify.passed ? "PASS" : "FAIL"}`);
      if (!iter.verify.passed) console.log(iter.verify.output.slice(0, 1000));
    }

    console.log(`\n[jira-harness] stopReason=${result.stopReason} success=${result.success} totalCostUsd=${result.totalCostUsd.toFixed(4)}`);
    console.log(`[jira-harness] worktree=${result.worktreeDir} branch=${branchName}`);
    process.exit(result.success ? 0 : 1);
  });

program
  .command("queue")
  .description(
    "Propose (not run) the next assigned ticket from Jira — requires a running `bot` (or the dashboard) " +
      "to actually approve it; no longer a safe thing to put on cron by itself. Prefer leaving `bot` running " +
      "continuously, which polls on its own — see HANDOFF.md.",
  )
  .action(async () => {
    // A standalone run writes its proposal to pending-state.json, which a running bot
    // never re-reads and overwrites on its next save — the paid analysis just vanishes.
    const { runningBotPid } = await import("./bot/lock.js");
    const botPid = runningBotPid();
    if (botPid) {
      console.error(`[queue] бот уже запущен (pid ${botPid}) и сам опрашивает очередь — отдельный запуск queue потерял бы своё предложение. Используй /start в Telegram или дашборд.`);
      process.exit(1);
    }
    try {
      const outcome = await runQueueOnce();
      console.log(`[queue] ${JSON.stringify(outcome)}`);
      process.exit(0);
    } catch (err) {
      console.error(`[queue] failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("bot")
  .description("Start the Telegram bot that drives the queue")
  .action(async () => {
    const { startBot } = await import("./bot/bot.js");
    await startBot();
  });

program
  .command("eval")
  .description("Run the mini eval set (real historical bugs) against the current model/prompt config")
  .option("--case <id...>", "Run only these case ids (default: all cases in evals/cases/)")
  .option("--model <name>", "Override IMPLEMENT_MODEL for this run only, to compare models")
  .option("--k <n>", "Run each case this many times (pass@1/pass^k instead of a single pass/fail)", "1")
  .action(async (opts) => {
    const { config } = await import("./config.js");
    const { runEvalSuite } = await import("./evals/runSuite.js");
    const { formatSuiteReport } = await import("./evals/report.js");

    const model = opts.model ?? config.models.implement;
    const k = Number(opts.k);
    // A bad --k (0, negative, non-numeric) used to reach runCaseKTimes's loop, which
    // just never runs, then aggregateAttempts reported a false PASS over zero real
    // attempts (average([]) is NaN, [].every(...) is vacuously true) — reproduced in
    // an earlier audit, not caught by anything until now. Failing fast here, with a
    // clear message, beats aggregateAttempts's own defensive throw surfacing as an
    // unhandled rejection deep inside the suite.
    if (!Number.isInteger(k) || k < 1) {
      console.error(`[eval] --k must be a positive integer, got ${JSON.stringify(opts.k)}`);
      process.exit(1);
    }
    console.log(`[eval] running ${opts.case ? opts.case.join(", ") : "all cases"} with model=${model}, k=${k}...`);

    try {
      const { result, savedTo } = await runEvalSuite(opts.case, {
        repos: config.repos,
        model,
        k,
        maxIterations: config.maxIterations,
        maxBudgetUsd: config.maxBudgetUsd,
        onCaseStart: (id) => console.log(`[eval] ${id}: starting...`),
        onAttemptDone: (id, i, total, r) =>
          console.log(`[eval] ${id} (${i}/${total}): ${r.passed ? "PASS" : "FAIL"} (${r.stopReason}, $${r.costUsd.toFixed(4)})`),
        onCaseDone: (agg) => console.log(`[eval] ${agg.caseId}: ${agg.passAtK ? "PASS" : "FAIL"} (pass@1=${agg.passAtOneRate.toFixed(2)})`),
      });

      console.log("\n" + formatSuiteReport(result));
      console.log(`\n[eval] saved to ${savedTo}`);
      process.exit(result.passAtKCount === result.totalCount ? 0 : 1);
    } catch (err) {
      console.error(`[eval] failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("dashboard")
  .description("Start only the dashboard web server (for testing without Telegram)")
  .action(async () => {
    const { config } = await import("./config.js");
    const { startDashboardServer, dashboardUrl } = await import("./web/server.js");
    startDashboardServer(config.dashboard.port, undefined, undefined, config.dashboard.host);
    console.log(`[dashboard] ${dashboardUrl(config.dashboard.port)}`);
  });

program.parseAsync(process.argv).catch((err: Error) => {
  console.error(`[jira-harness] ${err.message}`);
  process.exit(1);
});
