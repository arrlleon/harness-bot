import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// A push that GitLab never answers must fail (and become a retryable "push/MR failed"),
// not hang with a finished task behind it.
const GIT_NET = { timeout: Number(process.env.GIT_PUSH_TIMEOUT_MS) || 180_000, killSignal: "SIGKILL" as const, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } };
const HTTP_TIMEOUT_MS = 60_000;

// `harness/*` branches are the bot's own. A plain push fails as non-fast-forward when
// an earlier attempt at the same ticket already pushed one (pushed, MR failed, human
// rejected — the local branch is deleted on reject, the remote one used to stay). The
// fallback overwrites exactly the remote commit it just looked at, nothing newer.
export async function pushBranch(worktreeDir: string, branchName: string): Promise<void> {
  try {
    await execFileAsync("git", ["push", "-u", "origin", branchName], { cwd: worktreeDir, ...GIT_NET });
  } catch (err) {
    const message = String((err as { stderr?: string }).stderr ?? (err as Error).message);
    if (!/non-fast-forward|fetch first|rejected/i.test(message)) throw err;
    const { stdout } = await execFileAsync("git", ["ls-remote", "origin", `refs/heads/${branchName}`], { cwd: worktreeDir, ...GIT_NET });
    const remoteSha = stdout.trim().split(/\s+/)[0];
    if (!remoteSha) throw err;
    await execFileAsync("git", ["push", "-u", `--force-with-lease=${branchName}:${remoteSha}`, "origin", branchName], { cwd: worktreeDir, ...GIT_NET });
  }
}

// Best-effort: called when a human rejects a task whose branch may already be on the
// remote. Nothing depends on it succeeding.
export async function deleteRemoteBranch(repoPath: string, branchName: string): Promise<void> {
  await execFileAsync("git", ["push", "origin", "--delete", branchName], { cwd: repoPath, ...GIT_NET }).catch(() => {});
}

export interface CreateMrOptions {
  gitlabBaseUrl: string;
  token: string;
  projectPath: string; // e.g. "saqr/back-ai"
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description: string;
}

async function findOpenMergeRequest(opts: CreateMrOptions): Promise<string | null> {
  const projectId = encodeURIComponent(opts.projectPath);
  const query = `source_branch=${encodeURIComponent(opts.sourceBranch)}&target_branch=${encodeURIComponent(opts.targetBranch)}&state=opened`;
  const res = await fetch(`${opts.gitlabBaseUrl}/api/v4/projects/${projectId}/merge_requests?${query}`, {
    headers: { "PRIVATE-TOKEN": opts.token },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const list = (await res.json()) as Array<{ web_url: string }>;
  return list[0]?.web_url ?? null;
}

export async function createMergeRequest(opts: CreateMrOptions): Promise<{ webUrl: string }> {
  const projectId = encodeURIComponent(opts.projectPath);
  const res = await fetch(`${opts.gitlabBaseUrl}/api/v4/projects/${projectId}/merge_requests`, {
    method: "POST",
    headers: {
      "PRIVATE-TOKEN": opts.token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      source_branch: opts.sourceBranch,
      target_branch: opts.targetBranch,
      title: opts.title,
      description: opts.description,
      remove_source_branch: true,
    }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (res.status === 409) {
    // An MR for this branch is already open (a retry after the push succeeded but
    // something later failed) — that MR is the result, not an error.
    const existing = await findOpenMergeRequest(opts);
    if (existing) return { webUrl: existing };
  }
  if (!res.ok) {
    throw new Error(`GitLab MR creation failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { web_url: string };
  return { webUrl: data.web_url };
}
