import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function pushBranch(worktreeDir: string, branchName: string): Promise<void> {
  await execFileAsync("git", ["push", "-u", "origin", branchName], { cwd: worktreeDir });
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
  });
  if (!res.ok) {
    throw new Error(`GitLab MR creation failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { web_url: string };
  return { webUrl: data.web_url };
}
