import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runClaudeTurn } from "./claudeEngine.js";
import type { TaskSpec } from "../types.js";

const execFileAsync = promisify(execFile);

// Each acceptance criterion becomes its own it()/test() — one failure per criterion
// is far more legible to both the implementing agent and a human than one combined
// assertion. The test is expected to fail right now (no fix exists yet); that's
// stated explicitly so the model doesn't "helpfully" write a trivially-passing test
// instead of a real one.
export function buildAcceptanceTestPrompt(task: TaskSpec, relPath: string): string {
  const criteria = task.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n");
  return [
    `Задача ${task.id}: ${task.title}`,
    "",
    task.description,
    "",
    "Утверждённые критерии приёмки (зафиксированы человеком, формулировку менять нельзя):",
    criteria,
    "",
    `Напиши РОВНО ОДИН новый тестовый файл по пути ${relPath}, который проверяет`,
    "каждый критерий приёмки отдельным it()/test(). Файл должен существовать и",
    "компилироваться, но тесты ОБЯЗАНЫ сейчас падать — реализации ещё нет, это",
    "ожидаемо и правильно, не пытайся сделать их проходящими.",
    "",
    "Правила:",
    "- Сначала посмотри 2-3 существующих теста в этом репозитории (Read/Grep/Glob),",
    "  чтобы использовать те же соглашения: импорты, моки, настройка тестового",
    "  модуля, стиль проверок.",
    `- Создай РОВНО один файл: ${relPath}. Не редактируй и не создавай никакие`,
    "  другие файлы — ни конфиги, ни существующие тесты, ни исходный код.",
    "- Каждый критерий приёмки — отдельный it()/test() с понятным описанием.",
    "- Проверяй через публичное поведение (эндпоинт, сервис, компонент), а не",
    "  через внутренние детали реализации, которых ещё не существует.",
    "- Если критерий технически не проверяем автоматическим тестом, напиши",
    "  test.skip(...) с комментарием почему — не выдумывай фиктивную проверку.",
  ].join("\n");
}

interface TouchedPath {
  status: string;
  path: string;
}

async function gitStatusPaths(cwd: string): Promise<TouchedPath[]> {
  // --untracked-files=all: without it, git collapses a brand-new, entirely-untracked
  // directory (e.g. src/__acceptance__/, which doesn't exist before this step) into
  // one line for the directory itself rather than listing the file inside it —
  // reproduced live against a real Claude turn, which legitimately only created the
  // expected file but still failed this check because of the collapsed directory line.
  const { stdout } = await execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd });
  return stdout
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => ({ status: l.slice(0, 2), path: l.slice(3).trim() }));
}

export interface VerifyOutcome {
  ok: boolean;
  reason?: string;
}

// The mechanical check that makes the "exactly one new file, nothing else" mandate
// real rather than aspirational — a turn that also touched something else (even a
// config file) fails this regardless of how good the test itself looks, since nothing
// here re-reads the model's own account of what it did.
export async function verifyOnlyExpectedFileTouched(worktreeDir: string, expectedRelPath: string): Promise<VerifyOutcome> {
  const touched = await gitStatusPaths(worktreeDir);
  if (touched.length === 0) {
    return { ok: false, reason: "модель не создала файл с тестом" };
  }
  if (touched.length > 1 || touched[0].path !== expectedRelPath || touched[0].status !== "??") {
    return { ok: false, reason: `затронуто не только ожидаемое: ${touched.map((t) => t.path).join(", ")}` };
  }
  return { ok: true };
}

// Reverts whatever the acceptance-test turn did — safe to call broadly here
// specifically because this step runs immediately after createWorktree, before
// anything else has touched the worktree, so there's nothing legitimate to lose.
export async function discardAcceptanceTestAttempt(worktreeDir: string): Promise<void> {
  await execFileAsync("git", ["checkout", "--", "."], { cwd: worktreeDir }).catch(() => {});
  await execFileAsync("git", ["clean", "-fd"], { cwd: worktreeDir }).catch(() => {});
}

export interface AcceptanceTestOutcome {
  ok: boolean;
  relPath: string;
  costUsd: number;
  reason?: string;
}

// Writes exactly one acceptance-test file implementing the task's frozen criteria, in
// the given worktree, before any implementation work starts — so the test captures
// "before the fix" honestly (expected to fail), and implement can be mechanically
// denied Edit/Write on this exact path afterward (see loop.ts's extraDeniedPaths).
export async function writeAcceptanceTest(
  worktreeDir: string,
  task: TaskSpec,
  opts: { model: string; extraDeniedPaths?: string[]; ext: string; maxBudgetUsd?: number },
): Promise<AcceptanceTestOutcome> {
  const relPath = `src/__acceptance__/${task.id.toLowerCase()}.${opts.ext}`;
  const prompt = buildAcceptanceTestPrompt(task, relPath);

  const turn = await runClaudeTurn({
    cwd: worktreeDir,
    prompt,
    permissionMode: "acceptEdits",
    extraDeniedPaths: opts.extraDeniedPaths,
    model: opts.model,
    maxBudgetUsd: opts.maxBudgetUsd,
  });

  if (turn.isError) {
    await discardAcceptanceTestAttempt(worktreeDir);
    return { ok: false, relPath, costUsd: turn.totalCostUsd, reason: `ход завершился ошибкой: ${turn.resultText.slice(0, 200)}` };
  }

  const verified = await verifyOnlyExpectedFileTouched(worktreeDir, relPath);
  if (!verified.ok) {
    await discardAcceptanceTestAttempt(worktreeDir);
    return { ok: false, relPath, costUsd: turn.totalCostUsd, reason: verified.reason };
  }

  await execFileAsync("git", ["add", relPath], { cwd: worktreeDir });
  await execFileAsync(
    "git",
    ["commit", "-m", `${task.id}: acceptance test (frozen — implement cannot modify it)\n\nAutomated by jira-harness.`],
    { cwd: worktreeDir },
  );

  return { ok: true, relPath, costUsd: turn.totalCostUsd };
}
