import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContinuationPrompt, buildFeedbackPrompt, buildInitialPrompt } from "./prompts.js";
import type { GateResult, TaskSpec } from "../types.js";

test("buildInitialPrompt includes task id, title, description, and numbered criteria", () => {
  const task: TaskSpec = {
    id: "XEN-42",
    title: "Fix the thing",
    description: "It is broken.",
    acceptanceCriteria: ["Thing works", "No regressions"],
  };
  const prompt = buildInitialPrompt(task);
  assert.match(prompt, /XEN-42/);
  assert.match(prompt, /Fix the thing/);
  assert.match(prompt, /It is broken\./);
  assert.match(prompt, /1\. Thing works/);
  assert.match(prompt, /2\. No regressions/);
});

test("buildInitialPrompt includes memory context when given, and omits it when not", () => {
  const task: TaskSpec = { id: "XEN-42", title: "Fix the thing", description: "It is broken.", acceptanceCriteria: [] };
  const withMemory = buildInitialPrompt(task, "Накопленные заметки jira-harness: сервис X отвечает 30с");
  assert.match(withMemory, /отвечает 30с/);

  const withoutMemory = buildInitialPrompt(task);
  assert.doesNotMatch(withoutMemory, /Накопленные заметки/);
});

test("buildInitialPrompt tells the agent how to raise a brief instead of guessing", () => {
  const task: TaskSpec = { id: "XEN-42", title: "Fix the thing", description: "It is broken.", acceptanceCriteria: [] };
  const prompt = buildInitialPrompt(task);
  assert.match(prompt, /БРИФ/);
});

test("buildInitialPrompt omits the brief instructions when briefsEnabled is false", () => {
  const task: TaskSpec = { id: "XEN-42", title: "Fix the thing", description: "It is broken.", acceptanceCriteria: [] };
  const prompt = buildInitialPrompt(task, "", false);
  assert.doesNotMatch(prompt, /БРИФ/);
});

test("buildContinuationPrompt includes task id, title, criteria, and the diff verbatim", () => {
  const task: TaskSpec = {
    id: "XEN-539",
    title: "Show the department in the folder access modal",
    description: "Only the creator shows up today.",
    acceptanceCriteria: ["Department row appears", "Level matches FolderFormModal"],
  };
  const diff = "diff --git a/x.tsx b/x.tsx\n+ added a line";
  const prompt = buildContinuationPrompt(task, diff);
  assert.match(prompt, /XEN-539/);
  assert.match(prompt, /Show the department in the folder access modal/);
  assert.match(prompt, /1\. Department row appears/);
  assert.match(prompt, /2\. Level matches FolderFormModal/);
  assert.match(prompt, /added a line/);
});

test("buildContinuationPrompt says the previous session stopped on its own context budget, not that the work is done", () => {
  const task: TaskSpec = { id: "XEN-539", title: "t", description: "d", acceptanceCriteria: [] };
  const prompt = buildContinuationPrompt(task, "diff --git a/x b/x");
  assert.match(prompt, /context window/);
  assert.match(prompt, /not because the work was finished or verified/);
});

test("buildContinuationPrompt includes brief instructions by default and omits them when disabled", () => {
  const task: TaskSpec = { id: "XEN-539", title: "t", description: "d", acceptanceCriteria: [] };
  assert.match(buildContinuationPrompt(task, "diff"), /БРИФ/);
  assert.doesNotMatch(buildContinuationPrompt(task, "diff", false), /БРИФ/);
});

test("buildFeedbackPrompt reports each failing gate in its own labeled section", () => {
  const failed: GateResult[] = [
    { name: "typecheck", command: "tsc --noEmit", passed: false, output: "src/x.ts: error TS2322" },
    { name: "test", command: "yarn test", passed: false, output: "Tests: 3 failed, 10 passed" },
  ];
  const prompt = buildFeedbackPrompt(failed);
  assert.match(prompt, /2 gate\(s\) failed/);
  assert.match(prompt, /### typecheck \(`tsc --noEmit`\) failed/);
  assert.match(prompt, /error TS2322/);
  assert.match(prompt, /### test \(`yarn test`\) failed/);
  assert.match(prompt, /3 failed, 10 passed/);
});

test("buildFeedbackPrompt caps each gate's output independently", () => {
  const longOutput = "x".repeat(10_000);
  const failed: GateResult[] = [
    { name: "lint", command: "yarn lint", passed: false, output: longOutput },
    { name: "build", command: "yarn build", passed: false, output: "short failure" },
  ];
  const prompt = buildFeedbackPrompt(failed);
  // Each section is capped at 4000 chars — the long lint output shouldn't crowd the
  // short build failure out of the prompt entirely.
  assert.match(prompt, /short failure/);
  const lintSectionLength = prompt.split("### build")[0].length;
  assert.ok(lintSectionLength < 4200, `expected the lint section to be capped, got ${lintSectionLength} chars`);
});
