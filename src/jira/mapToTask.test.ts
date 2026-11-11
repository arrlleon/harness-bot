import { test } from "node:test";
import assert from "node:assert/strict";
import { detectRepo, retagTitle, toTaskSpec } from "./mapToTask.js";
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

test("retagTitle: replaces a [frontend] tag with [backend]", () => {
  assert.equal(retagTitle("[frontend] fix the thing", "backend"), "[backend] fix the thing");
});

test("retagTitle: [web] (frontend's alias) is also stripped, not left dangling alongside the new tag", () => {
  assert.equal(retagTitle("[web] fix the thing", "backend"), "[backend] fix the thing");
});

test("retagTitle: strips every existing tag, not just the first — a leftover second tag would make the ticket ambiguous again", () => {
  assert.equal(retagTitle("[frontend][backend] fix the thing", "backend"), "[backend] fix the thing");
});

test("retagTitle: adds the tag even if the title had none at all", () => {
  assert.equal(retagTitle("fix the thing", "frontend"), "[frontend] fix the thing");
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

// Audit finding (2026-11-12): title and description were read as one string, so a
// ticket retagged in its title but still mentioning the old tag in its description
// came back "ambiguous" and was dispatched cross-repo with no usable criteria.
test("detectRepo: a tagged title decides, whatever tags the description mentions", () => {
  assert.deepEqual(detectRepo({ key: "X-1", summary: "[backend] fix access", description: "раньше было помечено [web], шаги на фронте" }), { kind: "backend" });
});

test("detectRepo: the description is only consulted for an untagged title", () => {
  assert.deepEqual(detectRepo({ key: "X-1", summary: "fix access", description: "[frontend] кнопка" }), { kind: "frontend" });
  assert.deepEqual(detectRepo({ key: "X-1", summary: "[backend][frontend] fix access", description: "" }), { kind: "ambiguous" });
});
