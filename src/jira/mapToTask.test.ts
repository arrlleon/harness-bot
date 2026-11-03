import { test } from "node:test";
import assert from "node:assert/strict";
import { detectRepo, toTaskSpec } from "./mapToTask.js";
import type { JiraIssue } from "./client.js";

function issue(summary: string, description = ""): JiraIssue {
  return { key: "XEN-1", summary, description };
}

test("detectRepo: [backend] prefix routes to backend", () => {
  assert.deepEqual(detectRepo(issue("[backend] fix the thing")), { kind: "backend" });
});

test("detectRepo: [frontend] prefix routes to frontend", () => {
  assert.deepEqual(detectRepo(issue("[frontend] fix the thing")), { kind: "frontend" });
});

test("detectRepo: [web] is an alias for frontend", () => {
  assert.deepEqual(detectRepo(issue("[web] fix the thing")), { kind: "frontend" });
});

test("detectRepo: tag can live in the description instead of the title", () => {
  assert.deepEqual(detectRepo(issue("fix the thing", "see [backend] for context")), { kind: "backend" });
});

test("detectRepo: matching is case-insensitive", () => {
  assert.deepEqual(detectRepo(issue("[BACKEND] fix the thing")), { kind: "backend" });
});

test("detectRepo: both tags present is ambiguous, not a silent pick", () => {
  assert.deepEqual(detectRepo(issue("[backend][frontend] cross-cutting change")), { kind: "ambiguous" });
});

test("detectRepo: no tag at all is unknown, not a default", () => {
  assert.deepEqual(detectRepo(issue("fix the thing, no prefix")), { kind: "unknown" });
});

test("toTaskSpec: maps issue fields straight through with empty acceptance criteria", () => {
  const spec = toTaskSpec(issue("[backend] title here", "description here"));
  assert.deepEqual(spec, {
    id: "XEN-1",
    title: "[backend] title here",
    description: "description here",
    acceptanceCriteria: [],
  });
});
