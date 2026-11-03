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

    const result = await runCloseLoop(task, {
      repoPath: resolve(opts.repo),
      branchName,
      gates: [{ name: "test", command: opts.verify }],
      maxIterations: Number(opts.maxIterations),
      maxBudgetUsd: Number(opts.maxBudgetUsd),
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
  .description("Pick one assigned To Do ticket from Jira and run the close loop on it")
  .action(async () => {
    const outcome = await runQueueOnce();
    console.log(`[queue] ${JSON.stringify(outcome)}`);
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
  .action(async (opts) => {
    const { config } = await import("./config.js");
    const { runEvalSuite } = await import("./evals/runSuite.js");
    const { formatSuiteReport } = await import("./evals/report.js");

    const model = opts.model ?? config.models.implement;
    console.log(`[eval] running ${opts.case ? opts.case.join(", ") : "all cases"} with model=${model}...`);

    const { result, savedTo } = await runEvalSuite(opts.case, {
      repos: config.repos,
      model,
      maxIterations: config.maxIterations,
      maxBudgetUsd: config.maxBudgetUsd,
      onCaseStart: (id) => console.log(`[eval] ${id}: starting...`),
      onCaseDone: (r) => console.log(`[eval] ${r.caseId}: ${r.passed ? "PASS" : "FAIL"} (${r.stopReason}, $${r.costUsd.toFixed(4)})`),
    });

    console.log("\n" + formatSuiteReport(result));
    console.log(`\n[eval] saved to ${savedTo}`);
    process.exit(result.passCount === result.totalCount ? 0 : 1);
  });

program
  .command("dashboard")
  .description("Start only the dashboard web server (for testing without Telegram)")
  .action(async () => {
    const { config } = await import("./config.js");
    const { startDashboardServer, dashboardUrl } = await import("./web/server.js");
    startDashboardServer(config.dashboard.port);
    console.log(`[dashboard] ${dashboardUrl(config.dashboard.port)}`);
  });

program.parseAsync(process.argv);
