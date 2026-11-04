import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBrief, buildBriefAnswerPrompt, buildBriefInstructions, formatBriefAsText } from "./brief.js";
import type { Brief } from "../types.js";

test("parseBrief extracts question, options, recommendation, and rationale from a well-formed brief", () => {
  const text = [
    "БРИФ",
    "ВОПРОС: Как считать объём при нескольких победителях?",
    "ВАРИАНТЫ:",
    "1. Сумма итоговых ставок победителей",
    "2. Свой вариант",
    "РЕКОМЕНДАЦИЯ: 1",
    "ПОЧЕМУ: Совпадает с ручным отчётом в 29 из 29 процедур.",
  ].join("\n");
  const brief = parseBrief(text);
  assert.ok(brief);
  assert.equal(brief?.question, "Как считать объём при нескольких победителях?");
  assert.deepEqual(brief?.options, [{ label: "Сумма итоговых ставок победителей" }, { label: "Свой вариант" }]);
  assert.equal(brief?.recommendedIndex, 0);
  assert.equal(brief?.rationale, "Совпадает с ручным отчётом в 29 из 29 процедур.");
});

test("parseBrief returns null when there's no БРИФ heading — a normal response, not a half-parsed brief", () => {
  assert.equal(parseBrief("Implemented the fix in src/x.ts and ran the tests."), null);
});

test("parseBrief returns null when fewer than 2 options are present — not a real choice", () => {
  const text = ["БРИФ", "ВОПРОС: Что делать?", "ВАРИАНТЫ:", "1. Единственный вариант", "РЕКОМЕНДАЦИЯ: 1"].join("\n");
  assert.equal(parseBrief(text), null);
});

test("parseBrief treats РЕКОМЕНДАЦИЯ: НЕТ as no preference, not option 'НЕТ'", () => {
  const text = [
    "БРИФ",
    "ВОПРОС: Что делать?",
    "ВАРИАНТЫ:",
    "1. Вариант А",
    "2. Вариант Б",
    "РЕКОМЕНДАЦИЯ: НЕТ",
  ].join("\n");
  const brief = parseBrief(text);
  assert.equal(brief?.recommendedIndex, undefined);
});

test("parseBrief doesn't let a numbered line inside ПОЧЕМУ leak into the options list", () => {
  const text = [
    "БРИФ",
    "ВОПРОС: Что делать?",
    "ВАРИАНТЫ:",
    "1. Вариант А",
    "2. Вариант Б",
    "РЕКОМЕНДАЦИЯ: 1",
    "ПОЧЕМУ: есть 2 причины: 1. дешевле, 2. быстрее",
  ].join("\n");
  const brief = parseBrief(text);
  assert.equal(brief?.options.length, 2);
});

test("parseBrief tolerates missing rationale", () => {
  const text = ["БРИФ", "ВОПРОС: Что делать?", "ВАРИАНТЫ:", "1. Вариант А", "2. Вариант Б", "РЕКОМЕНДАЦИЯ: НЕТ"].join("\n");
  const brief = parseBrief(text);
  assert.ok(brief);
  assert.equal(brief?.rationale, undefined);
});

test("buildBriefAnswerPrompt names the question and the chosen option", () => {
  const brief: Brief = {
    question: "Как считать объём?",
    options: [{ label: "Сумма ставок" }, { label: "Свой вариант" }],
    recommendedIndex: 0,
  };
  const prompt = buildBriefAnswerPrompt(brief, 1);
  assert.match(prompt, /Как считать объём\?/);
  assert.match(prompt, /Свой вариант/);
  assert.doesNotMatch(prompt, /Сумма ставок/);
});

test("formatBriefAsText flattens the question, options, and recommendation into one line", () => {
  const brief: Brief = {
    question: "Как считать объём?",
    options: [{ label: "Сумма ставок" }, { label: "Свой вариант" }],
    recommendedIndex: 0,
    rationale: "Совпадает с ручным отчётом",
  };
  const text = formatBriefAsText(brief);
  assert.match(text, /Как считать объём\?/);
  assert.match(text, /1\. Сумма ставок ★/);
  assert.match(text, /2\. Свой вариант/);
  assert.doesNotMatch(text, /2\. Свой вариант ★/);
  assert.match(text, /Совпадает с ручным отчётом/);
});

test("buildBriefInstructions documents the exact format parseBrief expects", () => {
  const instructions = buildBriefInstructions();
  assert.match(instructions, /БРИФ/);
  assert.match(instructions, /ВОПРОС:/);
  assert.match(instructions, /ВАРИАНТЫ:/);
  assert.match(instructions, /РЕКОМЕНДАЦИЯ:/);
  assert.match(instructions, /ПОЧЕМУ:/);
});
