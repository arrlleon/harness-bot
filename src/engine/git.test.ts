import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  createWorktree,
  removeWorktree,
  deleteBranch,
  commitAll,
  getWorktreeDiff,
  worktreeDirFor,
  restorePathsFromCommit,
  fetchFreshBase,
  rebaseOntoFreshBase,
} from "./git.js";

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

// For fetchFreshBase tests: a bare "origin" plus a local clone of it on branch "dev" —
// the local clone's HEAD can legitimately go stale relative to origin once something
// else pushes directly to it, which is the exact gap fetchFreshBase closes.
async function makeRepoWithRemote(): Promise<{ origin: string; local: string }> {
  const origin = await mkdtemp(join(tmpdir(), "jira-harness-git-origin-"));
  await execFileAsync("git", ["init", "-q", "--bare"], { cwd: origin });

  const seed = await mkdtemp(join(tmpdir(), "jira-harness-git-seed-"));
  await execFileAsync("git", ["init", "-q"], { cwd: seed });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: seed });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: seed });
  await writeFile(join(seed, "README.md"), "initial\n");
  await execFileAsync("git", ["add", "-A"], { cwd: seed });
  await execFileAsync("git", ["commit", "-q", "-m", "initial"], { cwd: seed });
  await execFileAsync("git", ["branch", "-M", "dev"], { cwd: seed });
  await execFileAsync("git", ["remote", "add", "origin", origin], { cwd: seed });
  await execFileAsync("git", ["push", "-q", "origin", "dev"], { cwd: seed });
  await rm(seed, { recursive: true, force: true });

  const local = await mkdtemp(join(tmpdir(), "jira-harness-git-local-"));
  await execFileAsync("git", ["clone", "-q", "-b", "dev", origin, local]);
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: local });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: local });
  return { origin, local };
}

// Simulates someone else pushing straight to origin/dev while `local` never pulls —
// a throwaway clone pushes, rather than pushing from `local` itself, so `local`'s own
// HEAD and refs stay exactly as stale as a real harness host's would.
async function pushDirectlyToOrigin(origin: string, newContent: string): Promise<void> {
  const other = await mkdtemp(join(tmpdir(), "jira-harness-git-other-"));
  await execFileAsync("git", ["clone", "-q", "-b", "dev", origin, other]);
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: other });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: other });
  await writeFile(join(other, "README.md"), newContent);
  await execFileAsync("git", ["commit", "-q", "-am", "pushed directly to origin"], { cwd: other });
  await execFileAsync("git", ["push", "-q", "origin", "dev"], { cwd: other });
  await rm(other, { recursive: true, force: true });
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
    // The force-recreate wipes whatever the previous run left behind — exactly the
    // behavior that makes this safe for a crashed/abandoned run, but destructive for a
    // live one: runCloseLoop must never reach this branch while resuming a brief
    // (reproduced live — see CloseLoopResumeState.worktreeDir's own comment).
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

test("without fetchFreshBase, a stale local checkout branches a new task from its own outdated HEAD", async () => {
  const { origin, local } = await makeRepoWithRemote();
  const branch = uniqueBranch();
  try {
    await pushDirectlyToOrigin(origin, "initial\nnewer on origin\n");

    // No fetchFreshBase call — createWorktree's default behavior (no startPoint),
    // exactly what a real task's worktree creation does without this feature.
    const dir = await createWorktree(local, branch);
    const content = await readFile(join(dir, "README.md"), "utf8");
    assert.equal(content, "initial\n"); // still the stale commit — confirms the gap is real
  } finally {
    await cleanup(local, branch);
    await rm(origin, { recursive: true, force: true });
  }
});

test("fetchFreshBase returns a ref pointing at the remote's real current tip, past a stale local HEAD", async () => {
  const { origin, local } = await makeRepoWithRemote();
  const branch = uniqueBranch();
  try {
    await pushDirectlyToOrigin(origin, "initial\nnewer on origin\n");

    const ref = await fetchFreshBase(local, "dev");
    assert.equal(ref, "origin/dev");

    const dir = await createWorktree(local, branch, ref);
    const content = await readFile(join(dir, "README.md"), "utf8");
    assert.equal(content, "initial\nnewer on origin\n");
  } finally {
    await cleanup(local, branch);
    await rm(origin, { recursive: true, force: true });
  }
});

test("rebaseOntoFreshBase cleanly replays worktree work onto new remote commits, keeping uncommitted changes", async () => {
  const { origin, local } = await makeRepoWithRemote();
  const branch = uniqueBranch();
  try {
    const dir = await createWorktree(local, branch);
    await writeFile(join(dir, "worktree-change.txt"), "from the worktree\n");
    await execFileAsync("git", ["add", "-A"], { cwd: dir });
    await execFileAsync("git", ["commit", "-q", "-m", "worktree change"], { cwd: dir });
    await writeFile(join(dir, "uncommitted.txt"), "not yet committed\n");

    // A real regression had this: another task (or a human) pushes straight to dev
    // while this worktree, paused on a brief, sits untouched — unrelated to the
    // worktree's own change, so this should rebase clean.
    await pushDirectlyToOrigin(origin, "initial\nnewer on origin\n");

    const outcome = await rebaseOntoFreshBase(dir, "dev");
    assert.equal(outcome.conflict, false);

    const readme = await readFile(join(dir, "README.md"), "utf8");
    assert.equal(readme, "initial\nnewer on origin\n");
    const worktreeChange = await readFile(join(dir, "worktree-change.txt"), "utf8");
    assert.equal(worktreeChange, "from the worktree\n");
    // The autostash round-trip must hand uncommitted work back, not just the commits.
    const uncommitted = await readFile(join(dir, "uncommitted.txt"), "utf8");
    assert.equal(uncommitted, "not yet committed\n");
  } finally {
    await cleanup(local, branch);
    await rm(origin, { recursive: true, force: true });
  }
});

test("rebaseOntoFreshBase is a safe no-op when the remote has nothing new", async () => {
  const { origin, local } = await makeRepoWithRemote();
  const branch = uniqueBranch();
  try {
    const dir = await createWorktree(local, branch);
    const outcome = await rebaseOntoFreshBase(dir, "dev");
    assert.equal(outcome.conflict, false);
  } finally {
    await cleanup(local, branch);
    await rm(origin, { recursive: true, force: true });
  }
});

test("rebaseOntoFreshBase detects a real conflict and leaves the worktree back in its clean pre-rebase state", async () => {
  const { origin, local } = await makeRepoWithRemote();
  const branch = uniqueBranch();
  try {
    const dir = await createWorktree(local, branch);
    await writeFile(join(dir, "README.md"), "initial\nfrom the worktree\n");
    await execFileAsync("git", ["commit", "-qam", "worktree edits the same line"], { cwd: dir });

    // Origin edits the exact same line a different way — a genuine conflict, not
    // just two unrelated changes landing near each other.
    await pushDirectlyToOrigin(origin, "initial\nfrom origin\n");

    const outcome = await rebaseOntoFreshBase(dir, "dev");
    assert.equal(outcome.conflict, true);
    assert.match(outcome.output, /conflict/i);

    // Aborted back to exactly where it was — the worktree's own content, no
    // half-finished rebase left for a human (or a later resume) to find.
    const readme = await readFile(join(dir, "README.md"), "utf8");
    assert.equal(readme, "initial\nfrom the worktree\n");
    const { stdout: status } = await execFileAsync("git", ["status", "--porcelain=v1"], { cwd: dir });
    assert.equal(status.trim(), "");
    const { stdout: branchStatus } = await execFileAsync("git", ["status"], { cwd: dir });
    assert.doesNotMatch(branchStatus, /rebas(e|ing)/i);
  } finally {
    await cleanup(local, branch);
    await rm(origin, { recursive: true, force: true });
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
