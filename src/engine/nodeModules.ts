import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { symlink } from "node:fs/promises";

const execFileAsync = promisify(execFile);

// A worktree borrows the main checkout's node_modules. A symlink is enough for jest,
// tsc and `nest build`, but not for `next build`: Turbopack refuses a node_modules that
// "points out of the filesystem root" and fails before compiling anything. The build
// gate was then red at baseline on every front-ai task and silently tolerated — it never
// checked a single change (found on XEN-1111, 2026-11-24). A copy-on-write clone
// (`cp -c`, APFS clonefile) is a real directory for the bundler, takes ~10 s for
// front-ai's ~900 MB and almost no disk until something in it is written. Where cloning
// isn't available (not APFS, not macOS), it falls back to the symlink.
export async function provideNodeModules(source: string, target: string, clone: boolean): Promise<"clone" | "symlink" | "none"> {
  if (clone) {
    const cloned = await execFileAsync("cp", ["-c", "-R", source, target], { timeout: 300_000 })
      .then(() => true)
      .catch(() => false);
    if (cloned) return "clone";
    await execFileAsync("rm", ["-rf", target]).catch(() => {});
  }
  return symlink(source, target, "dir")
    .then(() => "symlink" as const)
    .catch(() => "none" as const);
}
