import { test } from "node:test";
import assert from "node:assert/strict";
import { totalContextTokens } from "./loop.js";

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
