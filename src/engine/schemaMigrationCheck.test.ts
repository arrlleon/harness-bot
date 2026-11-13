import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const SCRIPT = fileURLToPath(new URL("../../scripts/schema-migration-check.mjs", import.meta.url));

const ENTITY = `import { Column, Entity } from 'typeorm';

@Entity('folders')
export class Folder {
  /** Название папки. */
  @Column({ name: 'name' })
  name: string;
}
`;

// A real git repo with a `dev` branch holding one entity and one migration; the task's
// work happens on a branch off it, exactly as in a harness worktree.
async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jira-harness-schema-check-"));
  const git = (...args: string[]) => execFileAsync("git", args, { cwd: dir });
  await git("init", "-q", "-b", "dev");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test");
  await mkdir(join(dir, "src/entities"), { recursive: true });
  await mkdir(join(dir, "src/database/migrations"), { recursive: true });
  await writeFile(join(dir, "src/entities/folder.entity.ts"), ENTITY);
  await writeFile(join(dir, "src/database/migrations/1-Init.ts"), "export class Init1 {}\n");
  await git("add", "-A");
  await git("commit", "-q", "-m", "initial");
  await git("checkout", "-q", "-b", "harness/task");
  return dir;
}

function run(dir: string): { code: number | null; out: string } {
  const r = spawnSync("node", [SCRIPT], { cwd: dir, encoding: "utf8" });
  return { code: r.status, out: r.stdout + r.stderr };
}

const WITH_COLUMN = ENTITY.replace("  name: string;\n", "  name: string;\n\n  @Column({ name: 'has_custom_access', type: 'boolean', default: false })\n  hasCustomAccess: boolean;\n");

// XEN-540, live: exactly this change reached an MR with no migration.
test("a new @Column with no migration fails the gate and names the entity file", async () => {
  const dir = await makeRepo();
  try {
    await writeFile(join(dir, "src/entities/folder.entity.ts"), WITH_COLUMN);
    const { code, out } = run(dir);
    assert.equal(code, 1, out);
    assert.match(out, /СХЕМА БАЗЫ ИЗМЕНЕНА БЕЗ МИГРАЦИИ/);
    assert.match(out, /src\/entities\/folder\.entity\.ts/);
    assert.match(out, /has_custom_access/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the same change passes once a new migration file is added, committed or not", async () => {
  const dir = await makeRepo();
  try {
    await writeFile(join(dir, "src/entities/folder.entity.ts"), WITH_COLUMN);
    await writeFile(join(dir, "src/database/migrations/2-AddHasCustomAccess.ts"), "export class Add2 {}\n");
    assert.equal(run(dir).code, 0);
    await execFileAsync("git", ["add", "-A"], { cwd: dir });
    await execFileAsync("git", ["commit", "-q", "-m", "work"], { cwd: dir });
    assert.equal(run(dir).code, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("editing an existing migration does not count as adding one", async () => {
  const dir = await makeRepo();
  try {
    await writeFile(join(dir, "src/entities/folder.entity.ts"), WITH_COLUMN);
    await writeFile(join(dir, "src/database/migrations/1-Init.ts"), "export class Init1 { /* edited */ }\n");
    assert.equal(run(dir).code, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a comment, a method or a non-entity file changing asks for no migration", async () => {
  const dir = await makeRepo();
  try {
    await writeFile(
      join(dir, "src/entities/folder.entity.ts"),
      ENTITY.replace("/** Название папки. */", "/** Название папки (до 255 символов). */").replace("  name: string;\n", "  name: string;\n\n  label(): string {\n    return this.name;\n  }\n"),
    );
    await writeFile(join(dir, "src/service.ts"), "export const x = 1;\n");
    const { code, out } = run(dir);
    assert.equal(code, 0, out);
    assert.match(out, /миграция не нужна/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a brand-new entity file and a removed column both need a migration", async () => {
  const dir = await makeRepo();
  try {
    await writeFile(join(dir, "src/entities/note.entity.ts"), ENTITY.replace(/Folder/g, "Note").replace("folders", "notes"));
    assert.equal(run(dir).code, 1);
    await rm(join(dir, "src/entities/note.entity.ts"));
    await writeFile(join(dir, "src/entities/folder.entity.ts"), ENTITY.replace("  /** Название папки. */\n  @Column({ name: 'name' })\n  name: string;\n", ""));
    assert.equal(run(dir).code, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
