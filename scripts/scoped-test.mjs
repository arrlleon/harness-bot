#!/usr/bin/env node
// Diff-scoped Jest gate: runs only the unit tests next to what the task changed, and
// fails only on failures that are NEW relative to the task's base commit.
//
// Why scoped: back-ai's full suite is 1200+ spec files and 45+ minutes, on every
// iteration (XEN-541, 2026-11-10).
// Why by directory, not `jest --findRelatedTests`: that walks the import graph, and
// NestJS's DI wiring pulled 275+ unrelated suites in from one touched file.
// Why compare against the base commit: a scoped gate has no pre-edit baseline (nothing
// is "changed" yet when baselines are taken), so it runs strict — and a strict gate
// used to fail forever on tests that were already red before the task started
// (XEN-540: two specs in modules/documents fail identically on a clean dev). Any
// failing spec file is re-run in a throwaway worktree at the merge-base; a failure
// that reproduces there is reported but not counted.
// Why not `--testPathIgnorePatterns`: any value passed to it on the CLI silently broke
// positional scoping in this jest version (reproduced with one pattern and with twenty).
// Files are enumerated here and handed to jest with --runTestsByPath instead.
//
// Known limit, accepted for the speed: a change in a shared directory does not run the
// tests of the modules that import it.
//
// Exit 0 = no new failures. Exit 1 = new failures (listed first in the output, because
// the harness truncates what it feeds back to the agent). Exit 2 = jest itself broke.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

const TARGET_BRANCH = process.env.GITLAB_TARGET_BRANCH || "dev";
const EXCLUDE = new RegExp(process.env.SCOPED_TEST_EXCLUDE || "\\.integration\\.(spec|test)\\.[jt]sx?$");
const SPEC_FILE = /\.(spec|test)\.[jt]sx?$/;
const CODE_FILE = /\.[cm]?[jt]sx?$/;
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", ".git"]);
const MAX_MESSAGE_CHARS = 1500;

const cwd = process.cwd();
const log = (line) => console.log(`[scoped-test] ${line}`);

function git(args, dir = cwd) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function tryGit(args, dir = cwd) {
  try {
    return git(args, dir);
  } catch {
    return null;
  }
}

function resolveBase() {
  tryGit(["fetch", "origin", TARGET_BRANCH]);
  return tryGit(["merge-base", "HEAD", `origin/${TARGET_BRANCH}`]) ?? tryGit(["merge-base", "HEAD", TARGET_BRANCH]);
}

function changedFiles(base) {
  const tracked = git(["diff", "--name-only", "--diff-filter=ACMRD", base]).split("\n");
  const untracked = (tryGit(["ls-files", "--others", "--exclude-standard"]) ?? "").split("\n");
  return [...new Set([...tracked, ...untracked])].filter((f) => f && CODE_FILE.test(f));
}

function specsUnder(dir, recursive) {
  const found = [];
  const abs = join(cwd, dir);
  if (!existsSync(abs)) return found;
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive && !SKIP_DIRS.has(entry.name)) found.push(...specsUnder(rel, true));
    } else if (SPEC_FILE.test(entry.name) && !EXCLUDE.test(rel)) {
      found.push(rel);
    }
  }
  return found;
}

// Every changed file's own directory, plus the changed spec files themselves. A
// directory right under the repo root or one level in (`src/`) is scanned without
// recursion — recursing from there would be the whole suite again.
function scopeFor(changed) {
  const files = new Set();
  for (const dir of new Set(changed.map((f) => dirname(f)))) {
    if (dir === ".") continue;
    const depth = dir.split("/").length;
    for (const spec of specsUnder(dir, depth >= 2)) files.add(spec);
  }
  for (const f of changed) {
    if (SPEC_FILE.test(f) && !EXCLUDE.test(f) && existsSync(join(cwd, f))) files.add(f);
  }
  return [...files].sort();
}

// Colour codes out, and the test runner's own stack frames with them — they're most of
// a failure message's length and none of its meaning.
const stripAnsi = (text) =>
  String(text ?? "")
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .split("\n")
    .filter((line) => !/^\s+at .*(node_modules|node:internal)/.test(line))
    .join("\n");

function runJest(dir, files) {
  const jestBin = join(dir, "node_modules", ".bin", "jest");
  if (!existsSync(jestBin)) return { broken: `jest не найден в ${jestBin}` };
  const outDir = mkdtempSync(join(tmpdir(), "scoped-test-out-"));
  const outFile = join(outDir, "result.json");
  const run = spawnSync(jestBin, ["--ci", "--maxWorkers=75%", "--json", `--outputFile=${outFile}`, "--runTestsByPath", ...files], {
    cwd: dir,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 256,
  });
  try {
    if (!existsSync(outFile)) {
      return { broken: `jest не дал результата (код ${run.status ?? run.signal})\n${stripAnsi(run.stderr).slice(-3000)}` };
    }
    const report = JSON.parse(readFileSync(outFile, "utf8"));
    const root = realpathSync(dir);
    const failures = new Map();
    for (const suite of report.testResults ?? []) {
      const rel = relative(root, realpathSync(suite.name));
      const failed = (suite.assertionResults ?? []).filter((a) => a.status === "failed");
      for (const a of failed) failures.set(`${rel} › ${a.fullName}`, stripAnsi((a.failureMessages ?? []).join("\n")));
      // A suite that never got to run its tests (import error, syntax error).
      if (failed.length === 0 && suite.status === "failed") failures.set(`${rel} › (сьют не запустился)`, stripAnsi(suite.message));
    }
    return { failures, total: report.numTotalTests ?? 0, exitCode: run.status ?? 1 };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

// Re-runs the failing spec files at the base commit, in a throwaway worktree that
// borrows this checkout's node_modules. Files that don't exist at base (the task's own
// new tests) can't have been failing before — they're skipped and stay "new".
function failuresAtBase(base, failingFiles) {
  const existing = failingFiles.filter((f) => tryGit(["cat-file", "-e", `${base}:${f}`]) !== null);
  if (existing.length === 0) return new Map();
  const dir = mkdtempSync(join(tmpdir(), "scoped-test-base-"));
  try {
    git(["worktree", "add", "--detach", "--force", dir, base]);
    const nodeModules = join(cwd, "node_modules");
    if (existsSync(nodeModules)) symlinkSync(realpathSync(nodeModules), join(dir, "node_modules"), "dir");
    const result = runJest(dir, existing);
    if (result.broken) {
      log(`не удалось проверить базу (${result.broken.split("\n")[0]}) — считаю все падения новыми`);
      return new Map();
    }
    return result.failures;
  } finally {
    tryGit(["worktree", "remove", "--force", dir]);
    rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  const base = resolveBase();
  if (!base) {
    log(`не нашёл общий коммит с ${TARGET_BRANCH} — сужать не от чего, гейт не может отработать`);
    return 2;
  }

  const changed = changedFiles(base);
  if (changed.length === 0) {
    log(`изменений в коде относительно ${base.slice(0, 8)} нет — тестировать нечего`);
    return 0;
  }

  const files = scopeFor(changed);
  if (files.length === 0) {
    log(`рядом с изменёнными файлами нет unit-тестов (изменено: ${changed.join(", ")})`);
    return 0;
  }
  log(`${files.length} файлов тестов рядом с ${changed.length} изменёнными файлами`);

  const current = runJest(cwd, files);
  if (current.broken) {
    console.log(current.broken);
    return 2;
  }
  if (current.failures.size === 0) {
    if (current.exitCode !== 0) {
      log(`jest вернул код ${current.exitCode} без упавших тестов — считаю провалом`);
      return 1;
    }
    log(`все тесты прошли (${current.total})`);
    return 0;
  }

  const failingFiles = [...new Set([...current.failures.keys()].map((k) => k.split(" › ")[0]))];
  const atBase = failuresAtBase(base, failingFiles);
  const fresh = [...current.failures.keys()].filter((k) => !atBase.has(k));
  const old = [...current.failures.keys()].filter((k) => atBase.has(k));

  if (fresh.length > 0) {
    console.log(`НОВЫЕ ПАДЕНИЯ (${fresh.length}) — на базовом коммите ${base.slice(0, 8)} этих падений не было:\n`);
    for (const key of fresh) {
      console.log(`✕ ${key}`);
      console.log(current.failures.get(key).slice(0, MAX_MESSAGE_CHARS).replace(/^/gm, "    "));
      console.log("");
    }
  }
  if (old.length > 0) {
    console.log(`Уже падали на базовом коммите ${base.slice(0, 8)} — не из-за этой задачи, чинить их НЕ нужно (${old.length}):`);
    for (const key of old) console.log(`  - ${key}`);
  }
  if (fresh.length === 0) log("новых падений нет");
  return fresh.length > 0 ? 1 : 0;
}

process.exit(main());
