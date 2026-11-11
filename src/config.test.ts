import { test } from "node:test";
import assert from "node:assert/strict";
import { numberEnv } from "./config.js";

// Audit finding (2026-11-12): `Number("2O")` is NaN, and `spent >= NaN` is always
// false — a typo in DAILY_BUDGET_USD silently removed the daily cap.
test("numberEnv falls back when unset or blank", () => {
  assert.equal(numberEnv("X", 20, {}), 20);
  assert.equal(numberEnv("X", 20, { X: "  " }), 20);
});

test("numberEnv reads a valid number, including zero", () => {
  assert.equal(numberEnv("X", 20, { X: "35.5" }), 35.5);
  assert.equal(numberEnv("X", 20, { X: "0" }), 0);
});

test("numberEnv refuses garbage and negatives instead of returning NaN", () => {
  assert.throws(() => numberEnv("DAILY_BUDGET_USD", 20, { DAILY_BUDGET_USD: "2O" }), /DAILY_BUDGET_USD/);
  assert.throws(() => numberEnv("X", 20, { X: "-1" }), /non-negative/);
});
