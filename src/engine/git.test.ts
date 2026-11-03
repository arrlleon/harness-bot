import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createWorktree, removeWorktree, deleteBranch, commitAll, getWorktreeDiff, worktreeDirFor, restorePathsFromCommit } from "./git.js";

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

// Regression (XEN-427 live run): a plain `git diff <base>` is blind to brand-new
// untracked files — the agent's actual new controller/module was silently missing
// from a needs_human review, which only showed the files it happened to modify.
test("getWorktreeDiff includes brand-new untracked files, not just modified ones", async () => {
  const repo = await makeRepo();
  const branch = uniqueBranch();
  try {
    const dir = await createWorktree(repo, branch);
    await mkdir(join(dir, "src", "new-feature"), { recursive: true });
    await writeFile(join(dir, "src", "new-feature", "thing.ts"), "export const thing = 1;\n");

    const diff = await getWorktreeDiff(dir, "main").catch(() => getWorktreeDiff(dir, "master"));
    assert.match(diff, /src\/new-feature\/thing\.ts/);
    assert.match(diff, /\+export const thing = 1;/);
  } finally {
    await cleanup(repo, branch);
  }
});

test("getWorktreeDiff including untracked files doesn't change what commitAll later commits", async () => {
  const repo = await makeRepo();
  const branch = uniqueBranch();
  try {
    const dir = await createWorktree(repo, branch);
    await writeFile(join(dir, "new-file.txt"), "hello\n");

    await getWorktreeDiff(dir, "main").catch(() => getWorktreeDiff(dir, "master"));
    const committed = await commitAll(dir, "commit after a diff was viewed");
    assert.equal(committed, true);

    const { stdout } = await execFileAsync("git", ["show", "--stat", "HEAD"], { cwd: dir });
    assert.match(stdout, /new-file\.txt/);
  } finally {
    await cleanup(repo, branch);
  }
});

test("createWorktree accepts a startPoint and checks out that historical commit, not HEAD", async () => {
  const repo = await makeRepo();
  const branch = uniqueBranch();
  try {
    const baseCommit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
    await writeFile(join(repo, "README.md"), "initial\nlater change\n");
    await execFileAsync("git", ["commit", "-am", "later change"], { cwd: repo });

    const dir = await createWorktree(repo, branch, baseCommit);
    const content = await readFile(join(dir, "README.md"), "utf8");
    assert.equal(content, "initial\n"); // the pre-"later change" state, not current HEAD
  } finally {
    await cleanup(repo, branch);
  }
});

test("restorePathsFromCommit pulls a file's content from a later commit into an earlier-checked-out worktree", async () => {
  const repo = await makeRepo();
  const branch = uniqueBranch();
  try {
    const baseCommit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
    await writeFile(join(repo, "hidden.spec.ts"), "it('from the fix commit', () => {});\n");
    await execFileAsync("git", ["add", "-A"], { cwd: repo });
    await execFileAsync("git", ["commit", "-m", "add hidden test"], { cwd: repo });
    const referenceCommit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();

    const dir = await createWorktree(repo, branch, baseCommit);
    await assert.rejects(readFile(join(dir, "hidden.spec.ts"), "utf8")); // not present at baseCommit

    await restorePathsFromCommit(dir, referenceCommit, ["hidden.spec.ts"]);
    const content = await readFile(join(dir, "hidden.spec.ts"), "utf8");
    assert.equal(content, "it('from the fix commit', () => {});\n");
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

// Regression (live eval smoke test): removeWorktree alone left a stray eval/xen-302-*
// branch behind in front-ai — fine for a real task's branch (it's meant to become an
// MR), not fine for an eval run's throwaway one, which would accumulate every run.
test("deleteBranch removes a branch after its worktree is already gone", async () => {
  const repo = await makeRepo();
  const branch = uniqueBranch();
  const dir = await createWorktree(repo, branch);
  await removeWorktree(repo, dir);

  await deleteBranch(repo, branch);

  const { stdout } = await execFileAsync("git", ["branch", "--list", branch], { cwd: repo });
  assert.equal(stdout.trim(), "");
  await rm(repo, { recursive: true, force: true });
});

test("deleteBranch on a non-existent branch is a no-op, not an error", async () => {
  const repo = await makeRepo();
  await assert.doesNotReject(deleteBranch(repo, "no-such-branch"));
  await rm(repo, { recursive: true, force: true });
});
