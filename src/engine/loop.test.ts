import { test } from "node:test";
import assert from "node:assert/strict";
import { totalContextTokens, reviewResumeNowUnsafe } from "./loop.js";

test("totalContextTokens sums input, cache_read, and cache_creation tokens", () => {
  const tokens = totalContextTokens({
    inputTokens: 2,
    outputTokens: 500,
    cacheCreationInputTokens: 1_000,
    cacheReadInputTokens: 92_194,
  });
  // Mirrors the real spike finding: input_tokens alone (2) wildly understates context
  // — almost everything was served from cache, and that's what actually counts.
  assert.equal(tokens, 93_196);
});

test("totalContextTokens is zero when a turn reports no usage at all", () => {
  assert.equal(
    totalContextTokens({ inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }),
    0,
  );
});

test("reviewResumeNowUnsafe is false when there's nothing being resumed", () => {
  assert.equal(reviewResumeNowUnsafe(undefined, { maxRounds: 3 }), false);
  assert.equal(reviewResumeNowUnsafe(undefined, undefined), false);
});

test("reviewResumeNowUnsafe is false for the ordinary case: review still enabled, round still in range", () => {
  assert.equal(reviewResumeNowUnsafe({ round: 1 }, { maxRounds: 3 }), false);
  assert.equal(reviewResumeNowUnsafe({ round: 2 }, { maxRounds: 3 }), false);
});

test("reviewResumeNowUnsafe is true when review was disabled since the brief was raised", () => {
  // REVIEW_ENABLED flipped to false (+ bot restart) while a review-fix brief sat
  // pending — silently continuing would skip the pending human answer entirely.
  assert.equal(reviewResumeNowUnsafe({ round: 1 }, undefined), true);
});

test("reviewResumeNowUnsafe is true when MAX_REVIEW_ROUNDS was lowered below the resuming round", () => {
  // The brief was raised fixing round 3's findings; maxRounds dropped to 2 since —
  // a plain `for (round = 3; round <= 2; ...)` would never run at all.
  assert.equal(reviewResumeNowUnsafe({ round: 3 }, { maxRounds: 2 }), true);
});

test("reviewResumeNowUnsafe is false at the boundary: resuming round equals the current maxRounds", () => {
  assert.equal(reviewResumeNowUnsafe({ round: 2 }, { maxRounds: 2 }), false);
});
