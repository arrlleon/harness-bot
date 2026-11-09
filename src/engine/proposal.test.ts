import { test } from "node:test";
import assert from "node:assert/strict";
import { parseProposalResponse, parseWrongRepoSignal } from "./proposal.js";

test("parses a well-formed response into plan and criteria list", () => {
  const text = [
    "ПЛАН:",
    "Фильтр по статусу не учитывает архивные записи. Добавлю условие в WHERE.",
    "",
    "КРИТЕРИИ ПРИЁМКИ:",
    "- Архивные записи не попадают в выдачу по умолчанию",
    "- Существующие тесты на фильтрацию продолжают проходить",
    "- Добавлен новый тест на архивный случай",
  ].join("\n");

  const result = parseProposalResponse(text);

  assert.equal(result.plan, "Фильтр по статусу не учитывает архивные записи. Добавлю условие в WHERE.");
  assert.deepEqual(result.acceptanceCriteria, [
    "Архивные записи не попадают в выдачу по умолчанию",
    "Существующие тесты на фильтрацию продолжают проходить",
    "Добавлен новый тест на архивный случай",
  ]);
});

test("accepts '*' and '•' bullets, not just '-'", () => {
  const text = ["ПЛАН:", "x", "", "КРИТЕРИИ ПРИЁМКИ:", "* one", "• two", "- three"].join("\n");
  assert.deepEqual(parseProposalResponse(text).acceptanceCriteria, ["one", "two", "three"]);
});

test("tolerates the е/ё spelling variant in the heading", () => {
  const withE = ["ПЛАН:", "x", "", "КРИТЕРИИ ПРИЕМКИ:", "- a"].join("\n");
  assert.deepEqual(parseProposalResponse(withE).acceptanceCriteria, ["a"]);
});

test("falls back to plan-only when the model doesn't follow the format", () => {
  const freeform = "Просто сделаю вот это и вот то, без какой-либо структуры.";
  const result = parseProposalResponse(freeform);
  assert.equal(result.plan, freeform);
  assert.deepEqual(result.acceptanceCriteria, []);
});

test("returns an empty criteria list (not a crash) when the heading has no bullets under it", () => {
  const text = ["ПЛАН:", "x", "", "КРИТЕРИИ ПРИЁМКИ:", "(модель ничего не перечислила)"].join("\n");
  const result = parseProposalResponse(text);
  assert.equal(result.plan, "x");
  assert.deepEqual(result.acceptanceCriteria, []);
});

test("parseWrongRepoSignal: recognizes 'РЕПОЗИТОРИЙ: backend' at the start of the response", () => {
  assert.equal(parseWrongRepoSignal("РЕПОЗИТОРИЙ: backend"), "backend");
});

test("parseWrongRepoSignal: recognizes frontend too, and is case-insensitive", () => {
  assert.equal(parseWrongRepoSignal("репозиторий: FRONTEND"), "frontend");
});

test("parseWrongRepoSignal: null for a normal plan that just happens to mention 'backend' later on", () => {
  const text = ["ПЛАН:", "Фронтовая правка, бэкенд (backend) трогать не нужно.", "", "КРИТЕРИИ ПРИЁМКИ:", "- ок"].join("\n");
  assert.equal(parseWrongRepoSignal(text), null);
});

test("parseWrongRepoSignal: null for freeform text with no signal at all", () => {
  assert.equal(parseWrongRepoSignal("Просто обычный план без сигнала."), null);
});

test("ignores stray '-'/'*' lines that appear before the criteria heading", () => {
  const text = [
    "ПЛАН:",
    "- это не критерий, это просто дефис в плане",
    "",
    "КРИТЕРИИ ПРИЁМКИ:",
    "- настоящий критерий",
  ].join("\n");
  const result = parseProposalResponse(text);
  assert.equal(result.plan, "- это не критерий, это просто дефис в плане");
  assert.deepEqual(result.acceptanceCriteria, ["настоящий критерий"]);
});
