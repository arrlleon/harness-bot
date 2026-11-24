import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRemovePlaceholdersPrompt, findPlaceholderTests } from "./acceptancePlaceholders.js";

test("findPlaceholderTests finds the skip/todo placeholders acceptance files carried (XEN-1023..1111)", () => {
  const source = [
    "describe('x', () => {",
    "  it('AC1', async () => {});",
    "  test.skip('AC6: tsc --noEmit и eslint чистые', () => {});",
    "  it.todo('AC7');",
    "  xit('old', () => {});",
    "});",
  ].join("\n");
  assert.deepEqual(findPlaceholderTests(source), [3, 4, 5]);
});

test("findPlaceholderTests ignores comments and ordinary tests", () => {
  const source = [
    "// раньше тут был test.skip(...) для AC5",
    " * test.skip( в JSDoc",
    "it('AC1', () => { expect(skip).toBe(1); });",
  ].join("\n");
  assert.deepEqual(findPlaceholderTests(source), []);
});

test("buildRemovePlaceholdersPrompt names the file and the lines", () => {
  const prompt = buildRemovePlaceholdersPrompt("src/__acceptance__/xen-1.spec.ts", [3, 4]);
  assert.match(prompt, /xen-1\.spec\.ts/);
  assert.match(prompt, /строки 3, 4/);
});
