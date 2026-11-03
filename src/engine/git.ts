import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { symlink, access } from "node:fs/promises";

const execFileAsync = promisify(execFile);

export function worktreeDirFor(branchName: string): string {
  return join(tmpdir(), "jira-harness-worktrees", branchName);
}

export async function createWorktree(repoPath: string, branchName: string): Promise<string> {
  const dir = worktreeDirFor(branchName);
  // A prior run for the same ticket (crashed, killed, or left mid-flow) can leave this
  // exact worktree registered — `git worktree add` then refuses the directory outright,
  // even with -B, since git won't silently discard a worktree that might have uncommitted
  // work. Reproduced live (XEN-364, re-run after an earlier kill): force-remove first:
  // any real in-progress work there was already pushed or abandoned by that earlier run.
  await execFileAsync("git", ["worktree", "remove", "--force", dir], { cwd: repoPath }).catch(() => {});
  await execFileAsync("git", ["worktree", "add", "-B", branchName, dir], { cwd: repoPath });

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

export async function removeWorktree(repoPath: string, worktreeDir: string): Promise<void> {
  await execFileAsync("git", ["worktree", "remove", "--force", worktreeDir], { cwd: repoPath });
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
