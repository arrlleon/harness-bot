import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAcceptanceTestPrompt, discardAcceptanceTestAttempt, verifyOnlyExpectedFileTouched } from "./acceptanceTest.js";
import type { TaskSpec } from "../types.js";

const execFileAsync = promisify(execFile);

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jira-harness-acceptance-test-"));
  await execFileAsync("git", ["init", "-q"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await writeFile(join(dir, "README.md"), "initial\n");
  await execFileAsync("git", ["add", "-A"], { cwd: dir });
  await execFileAsync("git", ["commit", "-q", "-m", "initial"], { cwd: dir });
  return dir;
}

const task: TaskSpec = {
  id: "XEN-55",
  title: "Пагинация не работает для архивных записей",
  description: "Фильтр по статусу не учитывает архивные записи.",
  acceptanceCriteria: ["Архивные записи не попадают в выдачу по умолчанию", "Существующие тесты продолжают проходить"],
};

test("buildAcceptanceTestPrompt includes the task, the exact path, and every criterion numbered", () => {
  const prompt = buildAcceptanceTestPrompt(task, "src/__acceptance__/xen-55.spec.ts");
  assert.match(prompt, /XEN-55/);
  assert.match(prompt, /src\/__acceptance__\/xen-55\.spec\.ts/);
  assert.match(prompt, /1\. Архивные записи не попадают в выдачу по умолчанию/);
  assert.match(prompt, /2\. Существующие тесты продолжают проходить/);
  assert.match(prompt, /ОБЯЗАНЫ сейчас падать/);
});

test("verifyOnlyExpectedFileTouched passes when exactly the expected new file was added", async () => {
  const repo = await makeRepo();
  try {
    await writeFile(join(repo, "src-acceptance-xen-55.spec.ts"), "it('x', () => {});\n");
    const result = await verifyOnlyExpectedFileTouched(repo, "src-acceptance-xen-55.spec.ts");
    assert.equal(result.ok, true);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// Regression: `git status --porcelain` collapses a brand-new, entirely-untracked
// directory into one line for the directory itself instead of listing the file
// inside it — reproduced live against a real Claude turn that only created the
// expected file at src/__acceptance__/<id>.spec.ts but still failed this check
// because __acceptance__/ didn't exist before and git reported the directory, not
// the file, as the untracked path.
test("verifyOnlyExpectedFileTouched passes when the expected file lives in a brand-new subdirectory", async () => {
  const repo = await makeRepo();
  try {
    await mkdir(join(repo, "src", "__acceptance__"), { recursive: true });
    await writeFile(join(repo, "src", "__acceptance__", "xen-55.spec.ts"), "it('x', () => {});\n");
    const result = await verifyOnlyExpectedFileTouched(repo, "src/__acceptance__/xen-55.spec.ts");
    assert.equal(result.ok, true);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("verifyOnlyExpectedFileTouched fails when nothing was created", async () => {
  const repo = await makeRepo();
  try {
    const result = await verifyOnlyExpectedFileTouched(repo, "src-acceptance-xen-55.spec.ts");
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /не создала/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("verifyOnlyExpectedFileTouched fails when an existing tracked file was also modified", async () => {
  const repo = await makeRepo();
  try {
    await writeFile(join(repo, "README.md"), "modified by a wandering turn\n");
    await writeFile(join(repo, "expected.spec.ts"), "it('x', () => {});\n");
    const result = await verifyOnlyExpectedFileTouched(repo, "expected.spec.ts");
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /README\.md/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("verifyOnlyExpectedFileTouched fails when an extra stray file was also created", async () => {
  const repo = await makeRepo();
  try {
    await writeFile(join(repo, "expected.spec.ts"), "it('x', () => {});\n");
    await writeFile(join(repo, "oops.ts"), "// accidental extra file\n");
    const result = await verifyOnlyExpectedFileTouched(repo, "expected.spec.ts");
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /oops\.ts/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("discardAcceptanceTestAttempt reverts tracked changes and removes untracked ones", async () => {
  const repo = await makeRepo();
  try {
    await writeFile(join(repo, "README.md"), "wandered off\n");
    await writeFile(join(repo, "stray.ts"), "oops\n");

    await discardAcceptanceTestAttempt(repo);

    const { stdout: content } = await execFileAsync("cat", [join(repo, "README.md")]);
    assert.equal(content, "initial\n");
    const { stdout: status } = await execFileAsync("git", ["status", "--porcelain"], { cwd: repo });
    assert.equal(status.trim(), "");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
