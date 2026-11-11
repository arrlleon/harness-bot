import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { runClaudeTurn } from "./claudeEngine.js";
import { getWorktreeDiff } from "./git.js";
import type { AgentRole, TaskSpec } from "../types.js";

const execFileAsync = promisify(execFile);

// The team's own, human-maintained project memory (front-ai has one: open epics,
// "don't touch X" warnings, pending threads — real, actively curated state). It's
// NOT auto-loaded into every Claude Code session — only AGENTS.md is, via CLAUDE.md's
// @-import — so without reading it explicitly, propose/implement would only see it if
// the agent happened to read it unprompted. Read-only here, never written to. Shared
// across roles on purpose — it's the team's single file, not jira-harness's to split.
const TEAM_MEMORY_PATH = ".claude/memory/MEMORY.md";

// jira-harness's own accumulated notes — one file PER ROLE, not shared: the PM's notes
// about how this project tends to scope tickets shouldn't bleed into what the reviewer
// reads before judging a diff, and vice versa. Each role only ever reads its own file.
// Separate from the team's MEMORY.md on purpose too: never risk an automated process
// rewriting a team's actively-curated file (front-ai's has its own ≤30-line-index
// convention and real "не трогать" warnings — not something a bot should touch).
export function harnessMemoryPath(role: AgentRole): string {
  return `.claude/memory/jira-harness/${role}.md`;
}

async function readIfExists(path: string): Promise<string | null> {
  return readFile(path, "utf8").catch(() => null);
}

export async function readMemoryFiles(repoPath: string, role: AgentRole): Promise<{ team: string | null; harness: string | null }> {
  const [team, harness] = await Promise.all([
    readIfExists(join(repoPath, TEAM_MEMORY_PATH)),
    readIfExists(join(repoPath, harnessMemoryPath(role))),
  ]);
  return { team, harness };
}

// Omits a section entirely when that file doesn't exist, rather than showing the
// agent an empty block — most repos won't have a team memory file at all.
export function buildMemoryContextBlock(memories: { team: string | null; harness: string | null }, role: AgentRole): string {
  const sections: string[] = [];
  if (memories.team) {
    sections.push(
      ["Memory команды проекта (контекст; не редактируй этот файл):", "```markdown", memories.team.trim(), "```"].join("\n"),
    );
  }
  if (memories.harness) {
    sections.push(
      [
        `Накопленные заметки jira-harness (роль: ${role}) по прошлым задачам этого проекта:`,
        "```markdown",
        memories.harness.trim(),
        "```",
      ].join("\n"),
    );
  }
  return sections.join("\n\n");
}

const MEMORY_RESULT_TAG = /<memory>([\s\S]*?)<\/memory>/;

export function buildMemoryUpdatePrompt(task: TaskSpec, existingHarnessMemory: string | null, diffText: string): string {
  return [
    `Задача ${task.id}: ${task.title}`,
    "",
    task.description,
    "",
    "Эта задача только что успешно реализована и прошла все гейты. Итоговый diff:",
    "```diff",
    diffText.slice(0, 6000),
    "```",
    "",
    "Текущий файл заметок jira-harness по этому проекту:",
    "```markdown",
    existingHarnessMemory?.trim() || "(файла ещё нет)",
    "```",
    "",
    "Есть ли здесь НОВЫЙ, долгоживущий факт, решение или грабли — то, что сэкономит",
    "время в будущих задачах именно этого проекта (не пересказ самой задачи)? Примеры",
    "того, что стоит записать: неочевидное поведение сервиса/библиотеки, принятое",
    "архитектурное решение и почему, повторяющийся источник ошибок. НЕ записывай:",
    "пересказ diff'а, сам факт что задача закрыта, детали, и так очевидные из кода.",
    "",
    "Если да — выведи ПОЛНОЕ обновлённое содержимое файла целиком (существующее + новое,",
    "замени устаревшее, без дублей, не больше 150 строк) между тегами <memory>...</memory>.",
    "Если ничего долгоживущего нет — выведи ровно <memory>NONE</memory> и больше ничего.",
  ].join("\n");
}

export interface MemoryUpdateOutcome {
  updated: boolean;
  costUsd: number;
  reason?: string;
}

// Read-only turn, same shape as propose: the model never touches the filesystem, it
// returns text and the harness decides what to do with it. Sidesteps the whole
// "verify only one file changed" machinery acceptanceTest.ts needs for real code —
// there's no tool call here that could touch anything else, so nothing to verify.
export async function updateProjectMemory(
  worktreeDir: string,
  task: TaskSpec,
  opts: { model: string; baseBranch: string; role: AgentRole; maxBudgetUsd?: number },
): Promise<MemoryUpdateOutcome> {
  const relPath = harnessMemoryPath(opts.role);
  const existing = await readIfExists(join(worktreeDir, relPath));
  const diffText = await getWorktreeDiff(worktreeDir, opts.baseBranch).catch(() => "");

  const turn = await runClaudeTurn({
    cwd: worktreeDir,
    prompt: buildMemoryUpdatePrompt(task, existing, diffText),
    permissionMode: "acceptEdits",
    disallowedToolsOverride: "Bash,Edit,Write,MultiEdit",
    model: opts.model,
    maxBudgetUsd: opts.maxBudgetUsd,
  });

  if (turn.isError) {
    return { updated: false, costUsd: turn.totalCostUsd, reason: `ход завершился ошибкой: ${turn.resultText.slice(0, 200)}` };
  }

  const match = MEMORY_RESULT_TAG.exec(turn.resultText);
  if (!match || match[1].trim() === "NONE") {
    return { updated: false, costUsd: turn.totalCostUsd };
  }

  const newContent = match[1].trim() + "\n";
  const absPath = join(worktreeDir, relPath);
  await mkdir(dirname(absPath), { recursive: true });
  await writeFile(absPath, newContent);
  await execFileAsync("git", ["add", relPath], { cwd: worktreeDir });
  await execFileAsync(
    "git",
    ["commit", "-m", `${task.id}: update jira-harness project memory (${opts.role})\n\nAutomated by jira-harness.`],
    { cwd: worktreeDir },
  );

  return { updated: true, costUsd: turn.totalCostUsd };
}
