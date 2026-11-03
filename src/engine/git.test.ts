import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createWorktree, removeWorktree, commitAll, getWorktreeDiff, worktreeDirFor } from "./git.js";

const execFileAsync = promisify(execFile);

// A real git repo in a temp dir, isolated per test — createWorktree/commitAll shell
// out to real git, so these are small integration tests rather than pure-function unit
// tests. Each test picks its own unique branch name so worktreeDirFor (which points at
// a fixed location under the system tmpdir, shared across the whole process) can never
// collide between tests or with a real harness run.
async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jira-harness-git-test-"));
  await execFileAsync("git", ["init", "-q"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await writeFile(join(dir, "README.md"), "initial\n");
  await execFileAsync("git", ["add", "-A"], { cwd: dir });
  await execFileAsync("git", ["commit", "-q", "-m", "initial"], { cwd: dir });
  return dir;
}

function uniqueBranch(): string {
  return `test/${randomUUID()}`;
}

async function cleanup(repoPath: string, branchName: string): Promise<void> {
  await removeWorktree(repoPath, worktreeDirFor(branchName)).catch(() => {});
  await rm(repoPath, { recursive: true, force: true });
}

test("createWorktree creates a checked-out branch at the expected path", async () => {
  const repo = await makeRepo();
  const branch = uniqueBranch();
  try {
    const dir = await createWorktree(repo, branch);
    assert.equal(await realpath(dir), await realpath(worktreeDirFor(branch)));
    const content = await readFile(join(dir, "README.md"), "utf8");
    assert.equal(content, "initial\n");
    const { stdout } = await execFileAsync("git", ["branch", "--show-current"], { cwd: dir });
    assert.equal(stdout.trim(), branch);
  } finally {
    await cleanup(repo, branch);
  }
});

test("createWorktree symlinks node_modules from the main checkout when present", async () => {
  const repo = await makeRepo();
  const branch = uniqueBranch();
  try {
    await mkdir(join(repo, "node_modules"), { recursive: true });
    await writeFile(join(repo, "node_modules", "marker.txt"), "from main checkout\n");

    const dir = await createWorktree(repo, branch);
    const linked = await readFile(join(dir, "node_modules", "marker.txt"), "utf8");
    assert.equal(linked, "from main checkout\n");
  } finally {
    await cleanup(repo, branch);
  }
});

test("createWorktree does not fail when node_modules doesn't exist in the main checkout", async () => {
  const repo = await makeRepo();
  const branch = uniqueBranch();
  try {
    const dir = await createWorktree(repo, branch); // no node_modules in repo — shouldn't throw
    assert.ok(dir);
  } finally {
    await cleanup(repo, branch);
  }
});

test("createWorktree recovers from a stale worktree registration (prior crashed run)", async () => {
  const repo = await makeRepo();
  const branch = uniqueBranch();
  try {
    const first = await createWorktree(repo, branch);
    await writeFile(join(first, "scratch.txt"), "leftover from a killed run\n");
    // No removeWorktree call here — simulates a process that died mid-run, leaving the
    // worktree registered in git without a clean teardown.

    // Calling createWorktree again for the same branch must not throw "already exists".
    const second = await createWorktree(repo, branch);
    assert.equal(await realpath(second), await realpath(worktreeDirFor(branch)));
    // The force-recreate wipes whatever the previous run left behind.
    await assert.rejects(readFile(join(second, "scratch.txt"), "utf8"));
  } finally {
    await cleanup(repo, branch);
  }
});

test("commitAll commits pending changes and reports true, false when there's nothing to commit", async () => {
  const repo = await makeRepo();
  const branch = uniqueBranch();
  try {
    const dir = await createWorktree(repo, branch);
    await writeFile(join(dir, "new-file.txt"), "hello\n");

    const committed = await commitAll(dir, "add new-file.txt");
    assert.equal(committed, true);

    const committedAgain = await commitAll(dir, "nothing changed");
    assert.equal(committedAgain, false);

    const { stdout } = await execFileAsync("git", ["log", "--oneline", "-1"], { cwd: dir });
    assert.match(stdout, /add new-file\.txt/);
  } finally {
    await cleanup(repo, branch);
  }
});

test("getWorktreeDiff shows uncommitted changes against the base branch", async () => {
  const repo = await makeRepo();
  const branch = uniqueBranch();
  try {
    const dir = await createWorktree(repo, branch);
    await writeFile(join(dir, "README.md"), "initial\nchanged\n");

    const diff = await getWorktreeDiff(dir, "main").catch(() =>
      getWorktreeDiff(dir, "master"), // default branch name differs by git config
    );
    assert.match(diff, /\+changed/);
  } finally {
    await cleanup(repo, branch);
  }
});

test("getWorktreeDiff shows committed changes too (needs_human after a successful commit)", async () => {
  const repo = await makeRepo();
  const branch = uniqueBranch();
  try {
    const dir = await createWorktree(repo, branch);
    await writeFile(join(dir, "README.md"), "initial\ncommitted change\n");
    await commitAll(dir, "a committed fix");

    const diff = await getWorktreeDiff(dir, "main").catch(() => getWorktreeDiff(dir, "master"));
    assert.match(diff, /\+committed change/);
  } finally {
    await cleanup(repo, branch);
  }
});

test("removeWorktree makes the directory unusable as a worktree again", async () => {
  const repo = await makeRepo();
  const branch = uniqueBranch();
  const dir = await createWorktree(repo, branch);
  await removeWorktree(repo, dir);

  const { stdout } = await execFileAsync("git", ["worktree", "list"], { cwd: repo });
  assert.doesNotMatch(stdout, new RegExp(branch));
  await rm(repo, { recursive: true, force: true });
});
