import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { symlink, access } from "node:fs/promises";

const execFileAsync = promisify(execFile);

export function worktreeDirFor(branchName: string): string {
  return join(tmpdir(), "jira-harness-worktrees", branchName);
}

// startPoint lets evals/runCase.ts create a worktree at a specific historical commit
// (the case's baseCommit) instead of the repo's current HEAD — everything else about
// the worktree (symlinked node_modules, stale-registration recovery) works the same
// either way. Omitted, this is the exact same call real tasks have always used.
export async function createWorktree(repoPath: string, branchName: string, startPoint?: string): Promise<string> {
  const dir = worktreeDirFor(branchName);
  // A prior run for the same ticket (crashed, killed, or left mid-flow) can leave this
  // exact worktree registered — `git worktree add` then refuses the directory outright,
  // even with -B, since git won't silently discard a worktree that might have uncommitted
  // work. Reproduced live (XEN-364, re-run after an earlier kill): force-remove first:
  // any real in-progress work there was already pushed or abandoned by that earlier run.
  await execFileAsync("git", ["worktree", "remove", "--force", dir], { cwd: repoPath }).catch(() => {});
  const addArgs = ["worktree", "add", "-B", branchName, dir];
  if (startPoint) addArgs.push(startPoint);
  await execFileAsync("git", addArgs, { cwd: repoPath });

  // `git worktree add` gives a clean checkout with no node_modules (gitignored, not
  // part of the tree) — verifyCommand (yarn test/build) would fail on EVERY iteration
  // with a module-resolution error before it even gets to real test logic, regardless
  // of whether the agent's fix is correct. Reproduced live (XEN-364: all 5 iterations
  // burned on this alone). Symlinking from the main checkout is safe here specifically
  // because lockfiles are in DEFAULT_DENIED_PATHS — the agent can't drift dependencies
  // out from under the shared node_modules.
  const mainNodeModules = join(repoPath, "node_modules");
  const hasNodeModules = await access(mainNodeModules)
    .then(() => true)
    .catch(() => false);
  if (hasNodeModules) {
    await symlink(mainNodeModules, join(dir, "node_modules"), "dir").catch(() => {});
  }

  return dir;
}

// The harness never fetches or pulls repoPath's main checkout on its own otherwise —
// its local HEAD can be arbitrarily stale (days old) by the time a new task branches
// from it, which means gates/acceptance tests then run against code that's already
// behind whatever the eventual MR will actually be merged into. Fetching the target
// branch and handing back its remote-tracking ref as createWorktree's startPoint closes
// that gap: the ref it returns is a literal `origin/<branch>` name, not a resolved SHA,
// so it always means "whatever fetch just saw" at the moment it's used a line later.
// Modeled on Avengers Harness's "rebase onto fresh dev before gates" rule, but simpler
// here: a worktree with zero commits of its own has nothing to replay, so there's no
// rebase conflict to resolve — it only has to start from the right commit.
export async function fetchFreshBase(repoPath: string, targetBranch: string): Promise<string> {
  await execFileAsync("git", ["fetch", "origin", targetBranch], { cwd: repoPath });
  return `origin/${targetBranch}`;
}

export async function removeWorktree(repoPath: string, worktreeDir: string): Promise<void> {
  await execFileAsync("git", ["worktree", "remove", "--force", worktreeDir], { cwd: repoPath });
}

// `git worktree remove` only removes the directory — the branch itself survives.
// Harmless to call for a real task's branch too: by the time anything calls this, the
// branch is already pushed and the MR is built from `origin/<branch>` on GitLab, so
// deleting the local ref here loses nothing. Originally added for eval runs specifically
// (reproduced live: a stray eval/xen-302-* branch left behind after a single eval case,
// which would otherwise accumulate in the target repo on every eval-set run) — queue.ts
// now calls it for real tasks too, once they reach a genuinely final state (closed, or
// a needs_human case resolved either way). Call only for branches nothing should ever
// need again — never on a worktree a needs_human outcome still has pending.
export async function deleteBranch(repoPath: string, branchName: string): Promise<void> {
  await execFileAsync("git", ["branch", "-D", branchName], { cwd: repoPath }).catch(() => {});
}

export async function commitAll(worktreeDir: string, message: string): Promise<boolean> {
  await execFileAsync("git", ["add", "-A"], { cwd: worktreeDir });
  try {
    await execFileAsync("git", ["commit", "-m", message], { cwd: worktreeDir });
    return true;
  } catch {
    return false; // nothing to commit
  }
}

// Diffs against baseBranch rather than HEAD: a needs_human worktree can be either
// still-uncommitted (max_iterations — `git diff HEAD` would show it) or already
// committed (verified, but push/MR failed — HEAD would show nothing). Diffing against
// the branch point covers both the same way, so the human reviewing it sees the real
// change regardless of which failure path got them here.
//
// `git add -N .` (intent-to-add) first: a plain `git diff <base>` is blind to brand-new
// untracked files — reproduced live (XEN-427): the agent's actual new controller/module
// files were completely absent from the reviewed diff, which showed only the files it
// happened to *modify*. `-N` registers each untracked path in the index without staging
// its content, which is enough for `git diff` (not `--cached`) to show it as an addition;
// it doesn't change what a later `commitAll`'s own `git add -A` actually commits.
export async function getWorktreeDiff(worktreeDir: string, baseBranch: string): Promise<string> {
  await execFileAsync("git", ["add", "-N", "."], { cwd: worktreeDir });
  const { stdout } = await execFileAsync("git", ["diff", baseBranch], { cwd: worktreeDir, maxBuffer: 1024 * 1024 * 10 });
  return stdout;
}

// For evals: drops the real, historical test file(s) from a fix's own commit into a
// worktree checked out at the commit *before* that fix — works whether each path was
// brand new or pre-existing at that commit, since `checkout <commit> -- <path>` just
// writes that commit's content for the path, same either way. Both commits already
// exist in the same local repo's object database (no fetch needed): baseCommit is an
// ancestor of referenceCommit in the same clone.
export async function restorePathsFromCommit(worktreeDir: string, commit: string, paths: string[]): Promise<void> {
  await execFileAsync("git", ["checkout", commit, "--", ...paths], { cwd: worktreeDir });
}
