import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { HARNESS_STATE_DIR } from "./liveState.js";

// One bot per state directory. Two instances share pending-state.json and
// bot-state.json with no coordination — each overwrites what the other just wrote —
// and Telegram itself answers the second poller with 409. The same check lets the
// standalone `queue` command notice a running bot instead of writing a proposal into a
// file the bot will silently overwrite on its next save.
const LOCK_PATH = join(HARNESS_STATE_DIR, "bot.lock");

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: exists, just not ours to signal.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// The pid of a live bot holding the lock, or null (no lock, or a stale one left by a
// crash).
export function runningBotPid(lockPath = LOCK_PATH): number | null {
  if (!existsSync(lockPath)) return null;
  const pid = Number(readFileSync(lockPath, "utf8").trim());
  return Number.isInteger(pid) && pid > 0 && pid !== process.pid && isAlive(pid) ? pid : null;
}

export function acquireBotLock(lockPath = LOCK_PATH): void {
  const other = runningBotPid(lockPath);
  if (other) throw new Error(`Бот уже запущен (pid ${other}). Останови его перед запуском второго.`);
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, String(process.pid));
  const release = (): void => {
    try {
      if (readFileSync(lockPath, "utf8").trim() === String(process.pid)) unlinkSync(lockPath);
    } catch {
      // already gone
    }
  };
  process.once("exit", release);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      release();
      process.exit(0);
    });
  }
}
