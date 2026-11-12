import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { symlink, access, readFile } from "node:fs/promises";

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
// Worktrees borrow the main checkout's node_modules (see createWorktree). That's only
// right while both agree on what should be installed: reproduced live (XEN-540) with
// back-ai's main checkout missing a dependency its package.json already listed — eight
// suites "failed to run" and build was red before the agent touched anything. Returns
// the lockfile that differs, or null.
export async function lockfileDrift(repoPath: string, worktreeDir: string): Promise<string | null> {
  for (const name of ["yarn.lock", "package-lock.json", "pnpm-lock.yaml"]) {
    const [main, tree] = await Promise.all([readFile(join(repoPath, name), "utf8").catch(() => null), readFile(join(worktreeDir, name), "utf8").catch(() => null)]);
    if (main !== null && tree !== null && main !== tree) return name;
  }
  return null;
}

export async function fetchFreshBase(repoPath: string, targetBranch: string): Promise<string> {
  await execFileAsync("git", ["fetch", "origin", targetBranch], { cwd: repoPath });
  return `origin/${targetBranch}`;
}

export interface RebaseOutcome {
  conflict: boolean;
  // Diagnostic text for a human when conflict is true — raw git output, not parsed.
  output: string;
  // True only if HEAD actually moved (dev had real new commits to replay onto). A
  // caller holding gate baselines established before the pause should treat this as
  // "the underlying code just changed under those counts, re-measure them" — a
  // baseline-relative gate compares against the repo's OWN pre-existing failure count,
  // and dev moving on can shift that count in either direction without this task's own
  // work being at fault.
  rebased: boolean;
}

// Fetches origin/<targetBranch> and rebases the worktree's current branch onto it —
// used only when RESUMING a paused task (a brief, mid-task), where the worktree may
// have sat for hours or days while dev moved on. A brand-new worktree never reaches
// this: it has no commits of its own yet, so there's nothing to replay — see
// fetchFreshBase for that case instead, which just picks the right starting commit.
// `--autostash` covers uncommitted work still sitting in the worktree (the common case
// right after a brief pause, from iterations before the one that raised it): stashed
// before the rebase, re-applied after.
//
// On conflict — either the rebase itself, or the autostash re-applying cleanly rebased
// commits — aborts back to a clean pre-rebase state rather than leaving the worktree
// mid-conflict for a human or a later resume to stumble into. `git rebase --abort`
// restores the autostash too when the rebase itself was still in progress; if the
// rebase had already finished and only the stash pop conflicted, --abort is a no-op
// (nothing left "in progress") and a stash is left behind — the caller's escalation
// message says to check `git stash list` for that case.
export async function rebaseOntoFreshBase(worktreeDir: string, targetBranch: string): Promise<RebaseOutcome> {
  const { stdout: before } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: worktreeDir });
  await execFileAsync("git", ["fetch", "origin", targetBranch], { cwd: worktreeDir });
  // getWorktreeDiff leaves new files as intent-to-add entries in the index, and git
  // cannot stash those: the autostash failed with "Entry '<new file>' not uptodate.
  // Cannot merge" and the task was reported as a rebase conflict with nothing to
  // conflict (reproduced live, XEN-381). A mixed reset drops the entries and keeps
  // every file as it is; the new files simply ride through the rebase as untracked.
  await execFileAsync("git", ["reset", "-q"], { cwd: worktreeDir });
  try {
    const { stdout, stderr } = await execFileAsync("git", ["rebase", "--autostash", `origin/${targetBranch}`], { cwd: worktreeDir });
    const { stdout: after } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: worktreeDir });
    return { conflict: false, output: stdout + stderr, rebased: after.trim() !== before.trim() };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    const output = [e.stdout, e.stderr].filter(Boolean).join("\n") || e.message;
    await execFileAsync("git", ["rebase", "--abort"], { cwd: worktreeDir }).catch(() => {});
    return { conflict: true, output, rebased: false };
  }
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
// `baseBranch` alone (e.g. "dev") resolves to whatever the LOCAL branch ref happens to
// be in this repo right now — not what the worktree actually forked from, and not
// necessarily fresh: nothing besides a brand-new task's own createWorktree/
// rebaseOntoFreshBase ever updates it, so on a repo whose main checkout hasn't been
// pulled in a while it can be one or more merges behind. Reproduced live (2026-11-10):
// gate-integrity's diff against "dev" showed an entirely different, already-merged
// ticket's acceptance test as if THIS task had just added it, purely because the local
// "dev" ref predated that merge. `origin/<baseBranch>` alone fixes staleness but trades
// it for the opposite problem on a long-lived worktree: it keeps moving forward with
// OTHER people's merges while this task's own work sits still, so a live diff against
// "origin/dev right now" picks up all of that as noise too (reproduced the same day:
// an entirely unrelated feature's full diff, nothing to do with this task). The
// merge-base of HEAD and origin/<baseBranch> is the one fixed point that's neither —
// exactly where this worktree's own history forked, regardless of how stale the local
// ref is or how far origin has since moved on. Falls back to the plain branch name if
// there's no such remote at all (this project's own test repos have none) rather than
// hard-failing the whole diff over it.
async function resolveDiffBase(worktreeDir: string, baseBranch: string): Promise<string> {
  try {
    await execFileAsync("git", ["fetch", "origin", baseBranch], { cwd: worktreeDir });
    const { stdout } = await execFileAsync("git", ["merge-base", "HEAD", `origin/${baseBranch}`], { cwd: worktreeDir });
    return stdout.trim();
  } catch {
    return baseBranch;
  }
}

// `git add -N .` (intent-to-add) first: a plain `git diff <base>` is blind to brand-new
// untracked files — reproduced live (XEN-427): the agent's actual new controller/module
// files were completely absent from the reviewed diff, which showed only the files it
// happened to *modify*. `-N` registers each untracked path in the index without staging
// its content, which is enough for `git diff` (not `--cached`) to show it as an addition;
// it doesn't change what a later `commitAll`'s own `git add -A` actually commits.
export async function getWorktreeDiff(worktreeDir: string, baseBranch: string): Promise<string> {
  await execFileAsync("git", ["add", "-N", "."], { cwd: worktreeDir });
  const base = await resolveDiffBase(worktreeDir, baseBranch);
  const { stdout } = await execFileAsync("git", ["diff", base], { cwd: worktreeDir, maxBuffer: 1024 * 1024 * 100 });
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
