import { createServer, type Server } from "node:http";
import { getLiveState } from "../bot/liveState.js";
import { loadState, totalCostUsd, costSince, startOfTodayIso } from "../bot/state.js";
import { listCandidates, proposeIssueByKey, type Proposal } from "../queue.js";
import { DASHBOARD_PAGE } from "./page.js";

let server: Server | null = null;
let ticketsCache: { at: number; data: unknown } | null = null;
const TICKETS_CACHE_MS = 10_000; // Jira search isn't cheap to hammer on every client poll

function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// Reproduced live as a real gap (not just here — the same direct-dispatch pattern
// existed for the cron `queue` command too): the dashboard's "start" button used to
// call runTicketByKey, which ran the ENTIRE close loop — implement, review, push, open
// MR — with no propose step and no human ever seeing a plan or cost estimate first.
// Clicking "start" here now proposes exactly like Telegram's `pick:`, and `onProposal`
// (when the dashboard runs embedded in the bot process) announces it there with the
// same ✅/❌ buttons — the dashboard is a viewer + a way to kick off a proposal, not a
// second, ungated way to actually run a task. The standalone `dashboard` CLI command
// has no bot to announce through, so it omits the callback: a click there still
// proposes (and anyone watching Jira sees the pendingApproval take effect on /status
// once a bot is started), it just has nowhere to push a live notification.
// onNotice: anything a dashboard click produced that ISN'T a proposal — "skipped",
// "paused" (daily cap), "busy", or a thrown error. These used to vanish: the request
// had already answered 202, and the outcome went nowhere, so "start" just did nothing
// with no explanation anywhere.
export function startDashboardServer(
  port: number,
  onProposal?: (proposal: Proposal) => void,
  onNotice?: (text: string) => void,
  host = "127.0.0.1",
): void {
  if (server) return;
  server = createServer((req, res) => {
    if (req.url === "/api/state") {
      const persisted = loadState();
      sendJson(res, 200, {
        live: getLiveState(),
        botRunning: getLiveState().botRunning,
        totalCostUsd: totalCostUsd(persisted),
        costToday: costSince(persisted, startOfTodayIso()),
        history: persisted.history.slice(-20).reverse(),
      });
      return;
    }

    if (req.url === "/api/tickets" && req.method === "GET") {
      if (ticketsCache && Date.now() - ticketsCache.at < TICKETS_CACHE_MS) {
        sendJson(res, 200, ticketsCache.data);
        return;
      }
      listCandidates()
        .then((candidates) => {
          const data = candidates.map((c) => ({ ...c.issue, repo: c.detection.kind }));
          ticketsCache = { at: Date.now(), data };
          sendJson(res, 200, data);
        })
        .catch((err: Error) => sendJson(res, 502, { error: err.message }));
      return;
    }

    const startMatch = req.url?.match(/^\/api\/tickets\/([A-Za-z][A-Za-z0-9]*-\d+)\/start$/);
    if (startMatch && req.method === "POST") {
      const issueKey = startMatch[1];
      const live = getLiveState();
      if (live.currentJob || live.analyzing || live.pendingApproval || live.pendingHumanReview || live.pendingBrief) {
        sendJson(res, 409, { error: "already busy, or something else is waiting on a decision" });
        return;
      }
      sendJson(res, 202, { ok: true, issueKey });
      proposeIssueByKey(issueKey)
        .then((outcome) => {
          if (outcome.kind === "proposed") onProposal?.(outcome.proposal);
          else if (outcome.kind === "skipped") onNotice?.(`⏭️ ${issueKey}: пропущен (${outcome.reason})`);
          else if (outcome.kind === "paused") onNotice?.(`⏸ ${issueKey} не запущен: ${outcome.reason}`);
          else if (outcome.kind === "nothing_to_do")
            onNotice?.(`⚠️ ${issueKey}: анализ считает, что менять нечего (${outcome.reasons.map((r) => `${r.repo}: ${r.reason}`).join("; ").slice(0, 600)}). Напиши мне в чат, если делать всё равно.`);
          else onNotice?.(`${issueKey} не запущен с дашборда: бот занят другой задачей или ждёт решения.`);
        })
        .catch((err: Error) => {
          console.error(`[dashboard] propose for ${issueKey} failed:`, err.message);
          onNotice?.(`❌ ${issueKey}: не удалось проанализировать — ${err.message}`);
        });
      return;
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(DASHBOARD_PAGE);
  });
  // Without a handler an 'error' event (port already taken — a second bot instance, a
  // stale process) is an uncaught exception that takes the whole bot down with it.
  server.on("error", (err: NodeJS.ErrnoException) => {
    console.error(`[dashboard] не удалось запустить на ${host}:${port}: ${err.message}. Бот работает дальше без дашборда.`);
    server = null;
  });
  server.listen(port, host);
}

export function dashboardUrl(port: number): string {
  return `http://localhost:${port}/`;
}
