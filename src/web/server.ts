import { createServer, type Server } from "node:http";
import { getLiveState } from "../bot/liveState.js";
import { loadState, totalCostUsd, costSince, startOfTodayIso, recordOutcome, type BotState } from "../bot/state.js";
import { listCandidates, runTicketByKey } from "../queue.js";
import { DASHBOARD_PAGE } from "./page.js";

let server: Server | null = null;
let ticketsCache: { at: number; data: unknown } | null = null;
const TICKETS_CACHE_MS = 10_000; // Jira search isn't cheap to hammer on every client poll

function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// `sharedState`: when the dashboard runs embedded in the bot process, writes
// from a manual dashboard-started ticket must land on the SAME BotState object
// the bot's own /status and poll loop hold in memory — loading a fresh copy
// here and saving that instead would silently fork the two, and the bot's
// in-memory view would miss anything started from the dashboard until restart.
// The standalone `dashboard` CLI command has no bot state to share, so it falls
// back to a fresh load-mutate-save per write.
export function startDashboardServer(port: number, sharedState?: BotState): void {
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
      if (getLiveState().currentJob) {
        sendJson(res, 409, { error: "already busy with another ticket" });
        return;
      }
      ticketsCache = null; // the ticket about to run will leave "To Do" shortly
      sendJson(res, 202, { ok: true, issueKey });
      runTicketByKey(issueKey)
        .then((outcome) => recordOutcome(sharedState ?? loadState(), outcome))
        .catch((err: Error) => console.error(`[dashboard] manual run of ${issueKey} failed:`, err.message));
      return;
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(DASHBOARD_PAGE);
  });
  server.listen(port);
}

export function dashboardUrl(port: number): string {
  return `http://localhost:${port}/`;
}
