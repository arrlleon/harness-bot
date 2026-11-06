import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { ClaudeTurnResult } from "../types.js";
import { buildDisallowedTools } from "./guardrails.js";
import { SECRET_ENV_VARS, secretValues } from "../config.js";
import { scrubSecrets } from "./secretScrub.js";

// Denylist, not allowlist: the `claude` CLI's own auth/config env surface (PATH, HOME,
// proxy settings, NODE_OPTIONS, whatever it reads for login state) isn't fully known
// to this file, and an allowlist risks silently breaking it. Stripping exactly the
// harness's own secrets by name is the precise fix for the actual threat — the agent
// reading them back out via Bash — without touching anything `claude` itself needs.
export function buildAgentEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of SECRET_ENV_VARS) delete env[key];
  return env;
}

interface RunClaudeTurnOptions {
  cwd: string;
  prompt: string;
  permissionMode: string;
  resumeSessionId?: string;
  maxBudgetUsd?: number;
  extraDeniedPaths?: string[];
  // Bypasses the default guardrail deny-list with a caller-supplied value —
  // used for the read-only "propose a solution" turn, which denies Edit/Write
  // outright rather than just the usual sensitive-path subset.
  disallowedToolsOverride?: string;
  // Omit to inherit the CLI's own default model — every call site now passes one
  // explicitly (config.models.*) so this is effectively always set in practice.
  model?: string;
  onLog?: (line: string) => void;
}

// Tracked outside the promise closure so /kill can reach across process
// boundaries that don't share call stacks (Telegram command handler vs. the
// in-flight turn). Only one turn ever runs at a time (the queue is sequential).
let currentChild: ChildProcess | null = null;

export function killCurrentTurn(): boolean {
  if (!currentChild) return false;
  currentChild.kill("SIGTERM");
  return true;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function summarizeToolUse(name: string, input: Record<string, unknown>): string {
  const path = (input.file_path as string) ?? (input.path as string);
  switch (name) {
    case "Read":
      return `Чтение ${path}`;
    case "Edit":
    case "MultiEdit":
      return `Правка ${path}`;
    case "Write":
      return `Запись ${path}`;
    case "Grep":
      return `Поиск по коду: "${truncate(String(input.pattern ?? ""), 60)}"`;
    case "Glob":
      return `Поиск файлов: "${truncate(String(input.pattern ?? ""), 60)}"`;
    default:
      return name;
  }
}

// Each line of `stream-json` output is one complete JSON event (verified live,
// without --include-partial-messages): "assistant" per finished content block,
// "user" for tool results, and a final "result" line shaped exactly like the
// single-shot `--output-format json` result — so the existing result parsing
// below needs no change, just finding that one line instead of the whole blob.
export async function runClaudeTurn(opts: RunClaudeTurnOptions): Promise<ClaudeTurnResult> {
  // The agent only edits files; git (commit/push/MR) stays in the harness's own
  // hands, not the model's — also sidesteps Auto Mode's Bash classifier, which
  // blocks unattended shell commands in headless runs even under bypassPermissions.
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    opts.permissionMode,
    "--disallowedTools",
    opts.disallowedToolsOverride ?? buildDisallowedTools(opts.extraDeniedPaths),
  ];
  if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
  if (opts.maxBudgetUsd) args.push("--max-budget-usd", String(opts.maxBudgetUsd));
  if (opts.model) args.push("--model", opts.model);
  // `--disallowedTools` is variadic; without `--` to end option parsing, commander
  // can swallow the prompt itself into that list instead of treating it as the
  // positional argument (reproduced live — the run then fails with "Input must be
  // provided either through stdin or as a prompt argument").
  args.push("--", opts.prompt);

  let resultLine: Record<string, unknown> | null = null;
  let stderrText = "";

  await new Promise<void>((resolve, reject) => {
    const child = spawn("claude", args, { cwd: opts.cwd, env: buildAgentEnv() });
    currentChild = child;

    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line);
      } catch {
        return; // a stray non-JSON line shouldn't crash the turn
      }

      if (event.type === "result") {
        resultLine = event;
        return;
      }
      if (!opts.onLog) return;

      if (event.type === "assistant") {
        const content = ((event.message as Record<string, unknown>)?.content ?? []) as Array<Record<string, unknown>>;
        for (const block of content) {
          if (block.type === "tool_use") {
            opts.onLog(`→ ${summarizeToolUse(String(block.name), (block.input as Record<string, unknown>) ?? {})}`);
          } else if (block.type === "text" && block.text) {
            opts.onLog(truncate(String(block.text), 300));
          }
        }
      }
    });

    child.stderr.on("data", (chunk) => (stderrText += chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      currentChild = null;
      if (signal) {
        reject(new Error(`claude killed by ${signal}`));
        return;
      }
      if (code !== 0 && !resultLine) {
        reject(new Error(`claude exited with code ${code}: ${stderrText.trim()}`));
        return;
      }
      resolve();
    });
  });

  if (!resultLine) {
    throw new Error(`claude produced no result event. stderr:\n${stderrText.slice(0, 2000)}`);
  }

  const raw = resultLine as Record<string, unknown>;
  const usage = (raw.usage as Record<string, unknown>) ?? {};
  return {
    sessionId: String(raw.session_id ?? ""),
    // Scrubbed here, once, for every role — implement/acceptance's resultText is just
    // a status message (the real output is file edits, already outside this string),
    // while propose/review/memory/testing-notes/brief feed this straight into a Jira
    // comment, an MR description, or a committed memory file.
    resultText: scrubSecrets(String(raw.result ?? ""), secretValues()),
    isError: Boolean(raw.is_error),
    terminalReason: String(raw.terminal_reason ?? "unknown"),
    totalCostUsd: Number(raw.total_cost_usd ?? 0),
    usage: {
      inputTokens: Number(usage.input_tokens ?? 0),
      outputTokens: Number(usage.output_tokens ?? 0),
      cacheCreationInputTokens: Number(usage.cache_creation_input_tokens ?? 0),
      cacheReadInputTokens: Number(usage.cache_read_input_tokens ?? 0),
    },
  };
}
