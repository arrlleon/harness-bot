import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { killTaskChildren, trackTaskChild } from "./processRegistry.js";

function closed(child: ReturnType<typeof spawn>): Promise<NodeJS.Signals | null> {
  return new Promise((resolve) => child.once("close", (_code, signal) => resolve(signal)));
}

test("killTaskChildren reports false when nothing is running", () => {
  assert.equal(killTaskChildren(), false);
});

// Audit finding (2026-11-12): a single `currentChild` slot meant a second concurrent
// turn overwrote the first, and whichever finished first cleared the slot — /kill then
// said "nothing running" while the other kept going.
test("killTaskChildren stops every tracked child, not just the most recent", async () => {
  const a = spawn("sleep", ["30"]);
  const b = spawn("sleep", ["30"]);
  trackTaskChild(a);
  trackTaskChild(b);
  assert.equal(killTaskChildren(), true);
  assert.deepEqual(await Promise.all([closed(a), closed(b)]), ["SIGTERM", "SIGTERM"]);
  assert.equal(killTaskChildren(), false, "finished children are forgotten");
});

// A gate is `sh -c "<command>"`: signalling only the shell leaves the real work running.
test("a group-tracked child takes its descendants down with it", async () => {
  const shell = spawn("/bin/sh", ["-c", "sleep 30 & wait"], { detached: true });
  trackTaskChild(shell, { group: true });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(killTaskChildren(), true);
  await closed(shell);
  await new Promise((r) => setTimeout(r, 150));
  assert.throws(() => process.kill(-shell.pid!, 0), "the whole process group should be gone");
});
