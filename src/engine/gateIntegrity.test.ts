import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGateIntegrityViolations } from "./gateIntegrity.js";

test("parseGateIntegrityViolations finds nothing in a clean, normal diff", () => {
  const diff = [
    "diff --git a/src/users/users.service.ts b/src/users/users.service.ts",
    "index 1111111..2222222 100644",
    "--- a/src/users/users.service.ts",
    "+++ b/src/users/users.service.ts",
    "@@ -10,6 +10,7 @@",
    " export class UsersService {",
    "+  // fixed the off-by-one",
    "   find(id: string) {}",
    "",
    "diff --git a/src/users/users.service.test.ts b/src/users/users.service.test.ts",
    "--- a/src/users/users.service.test.ts",
    "+++ b/src/users/users.service.test.ts",
    "@@ -1,2 +1,3 @@",
    " describe('UsersService', () => {",
    "+  it('finds a user by id', () => {})",
  ].join("\n");
  assert.deepEqual(parseGateIntegrityViolations(diff), []);
});

test("parseGateIntegrityViolations flags a deleted test file", () => {
  const diff = [
    "diff --git a/src/users/users.service.test.ts b/src/users/users.service.test.ts",
    "deleted file mode 100644",
    "index 1111111..0000000",
    "--- a/src/users/users.service.test.ts",
    "+++ /dev/null",
  ].join("\n");
  const violations = parseGateIntegrityViolations(diff);
  assert.equal(violations.length, 1);
  assert.match(violations[0].description, /удалён тестовый файл: src\/users\/users\.service\.test\.ts/);
});

test("parseGateIntegrityViolations flags a newly added it.skip in a test file", () => {
  const diff = [
    "diff --git a/src/users/users.service.test.ts b/src/users/users.service.test.ts",
    "--- a/src/users/users.service.test.ts",
    "+++ b/src/users/users.service.test.ts",
    "@@ -1,3 +1,3 @@",
    "-it('finds a user by id', () => {})",
    "+it.skip('finds a user by id', () => {})",
  ].join("\n");
  const violations = parseGateIntegrityViolations(diff);
  assert.equal(violations.length, 1);
  assert.match(violations[0].description, /skip\/only\/todo/);
});

test("parseGateIntegrityViolations ignores a pre-existing skip marker shown only as context", () => {
  const diff = [
    "diff --git a/src/users/users.service.test.ts b/src/users/users.service.test.ts",
    "--- a/src/users/users.service.test.ts",
    "+++ b/src/users/users.service.test.ts",
    "@@ -1,3 +1,4 @@",
    " it.skip('already skipped before this change', () => {})",
    "+it('a genuinely new test', () => {})",
  ].join("\n");
  assert.deepEqual(parseGateIntegrityViolations(diff), []);
});

// Reproduced live (2026-11-10): the acceptance-test-writer role is explicitly told to
// use test.skip(...) for a criterion that genuinely isn't automatable (e.g. "tsc/build
// pass") — close to every task's acceptance criteria include one, so this used to flag
// on sanctioned, expected content, not a real attempt to weaken a gate.
test("parseGateIntegrityViolations ignores test.skip inside the known acceptance test path", () => {
  const diff = [
    "diff --git a/src/__acceptance__/xen-539.test.tsx b/src/__acceptance__/xen-539.test.tsx",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/__acceptance__/xen-539.test.tsx",
    "@@ -0,0 +1,2 @@",
    "+test.skip('AC4: tsc --noEmit and yarn build pass', () => {})",
  ].join("\n");
  assert.deepEqual(parseGateIntegrityViolations(diff, "src/__acceptance__/xen-539.test.tsx"), []);
});

// The exemption is scoped to exactly that one known path, not test files in general —
// implement skip-marking some OTHER, pre-existing test file still flags exactly as
// before, acceptanceTestPath argument or not.
test("parseGateIntegrityViolations still flags test.skip added to a DIFFERENT test file than the acceptance test", () => {
  const diff = [
    "diff --git a/src/users/users.service.test.ts b/src/users/users.service.test.ts",
    "--- a/src/users/users.service.test.ts",
    "+++ b/src/users/users.service.test.ts",
    "@@ -1,3 +1,3 @@",
    "-it('finds a user by id', () => {})",
    "+it.skip('finds a user by id', () => {})",
  ].join("\n");
  const violations = parseGateIntegrityViolations(diff, "src/__acceptance__/xen-539.test.tsx");
  assert.equal(violations.length, 1);
  assert.match(violations[0].description, /skip\/only\/todo/);
});

test("parseGateIntegrityViolations flags any touch to CI config", () => {
  const diff = [
    "diff --git a/.gitlab-ci.yml b/.gitlab-ci.yml",
    "--- a/.gitlab-ci.yml",
    "+++ b/.gitlab-ci.yml",
    "@@ -1,2 +1,2 @@",
    "-test: { script: yarn test }",
    "+test: { script: echo skip }",
  ].join("\n");
  const violations = parseGateIntegrityViolations(diff);
  assert.equal(violations.length, 1);
  assert.match(violations[0].description, /правка CI-конфига: \.gitlab-ci\.yml/);
});

test("parseGateIntegrityViolations flags a jest config change", () => {
  const diff = [
    "diff --git a/jest.config.js b/jest.config.js",
    "--- a/jest.config.js",
    "+++ b/jest.config.js",
    "@@ -1,2 +1,2 @@",
    "-testPathIgnorePatterns: []",
    "+testPathIgnorePatterns: ['users.service.test.ts']",
  ].join("\n");
  const violations = parseGateIntegrityViolations(diff);
  assert.equal(violations.length, 1);
  assert.match(violations[0].description, /правка конфига гейта: jest\.config\.js/);
});

test("parseGateIntegrityViolations flags a changed 'test' script in package.json, not unrelated keys", () => {
  const diff = [
    "diff --git a/package.json b/package.json",
    "--- a/package.json",
    "+++ b/package.json",
    '@@ -2,6 +2,7 @@',
    '   "name": "back-ai",',
    '+  "lodash": "^4.0.0",',
    '-  "test": "jest",',
    '+  "test": "jest --passWithNoTests",',
  ].join("\n");
  const violations = parseGateIntegrityViolations(diff);
  assert.equal(violations.length, 1);
  assert.match(violations[0].description, /скрипт "test" в package\.json/);
});

test("parseGateIntegrityViolations reports each distinct violation once, not per matching line", () => {
  const diff = [
    "diff --git a/src/a.test.ts b/src/a.test.ts",
    "--- a/src/a.test.ts",
    "+++ b/src/a.test.ts",
    "@@ -1,2 +1,2 @@",
    "+it.skip('one', () => {})",
    "+it.skip('two', () => {})",
  ].join("\n");
  assert.equal(parseGateIntegrityViolations(diff).length, 1);
});

test("parseGateIntegrityViolations returns nothing for an empty diff", () => {
  assert.deepEqual(parseGateIntegrityViolations(""), []);
});
