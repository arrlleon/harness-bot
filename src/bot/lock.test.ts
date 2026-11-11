import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { runningBotPid } from "./lock.js";

const lockIn = (): string => join(mkdtempSync(join(tmpdir(), "harness-lock-")), "bot.lock");

test("runningBotPid is null with no lock file", () => {
  assert.equal(runningBotPid(lockIn()), null);
});

test("runningBotPid ignores a stale lock left by a process that no longer exists", () => {
  const lock = lockIn();
  writeFileSync(lock, "2147483646");
  assert.equal(runningBotPid(lock), null);
});

test("runningBotPid ignores this process's own lock and garbage content", () => {
  const lock = lockIn();
  writeFileSync(lock, String(process.pid));
  assert.equal(runningBotPid(lock), null);
  writeFileSync(lock, "not-a-pid");
  assert.equal(runningBotPid(lock), null);
});

test("runningBotPid reports a live process holding the lock", async () => {
  const lock = lockIn();
  const child = spawn("sleep", ["30"]);
  try {
    writeFileSync(lock, String(child.pid));
    assert.equal(runningBotPid(lock), child.pid);
  } finally {
    child.kill("SIGKILL");
  }
});
