import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, lstat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provideNodeModules } from "./nodeModules.js";

async function sourceDir(): Promise<{ root: string; source: string }> {
  const root = await mkdtemp(join(tmpdir(), "nm-test-"));
  const source = join(root, "main", "node_modules");
  await mkdir(join(source, "pkg"), { recursive: true });
  await writeFile(join(source, "pkg", "index.js"), "module.exports = 1;\n");
  return { root, source };
}

test("provideNodeModules without clone links the main node_modules", async () => {
  const { root, source } = await sourceDir();
  const target = join(root, "tree-node_modules");
  assert.equal(await provideNodeModules(source, target, false), "symlink");
  assert.ok((await lstat(target)).isSymbolicLink());
});

test("provideNodeModules with clone gives a real directory where cloning works, else the link", async () => {
  const { root, source } = await sourceDir();
  const target = join(root, "tree-node_modules");
  const mode = await provideNodeModules(source, target, true);
  const st = await lstat(target);
  if (mode === "clone") {
    assert.ok(st.isDirectory() && !st.isSymbolicLink());
    assert.equal(await readFile(join(target, "pkg", "index.js"), "utf8"), "module.exports = 1;\n");
  } else {
    assert.equal(mode, "symlink");
    assert.ok(st.isSymbolicLink());
  }
});
