#!/usr/bin/env node
// Gate: a change to a TypeORM entity's schema must come with a migration.
//
// Reproduced live (XEN-540, MR 532): the task added `@Column({ name: 'has_custom_access' })`
// to an entity and used the column in raw SQL, with no migration. Every gate passed —
// the unit tests next to the change mock the database — and the MR's own pipeline then
// failed 228 tests on a real Postgres ("column f.has_custom_access does not exist").
// Running the DB-backed suites on every iteration is what the scoped test gate exists
// to avoid, so this checks the one thing they would have caught, from the diff alone.
//
// Deliberately narrow: only lines that add or remove a schema decorator count. A
// reworded comment, a new method or an @ApiProperty in an entity file doesn't ask for
// a migration. Known limit: an option changed on its own line inside a multi-line
// decorator (`nullable: true`) is not seen.
//
// Exit 0 = nothing to migrate, or a migration was added. Exit 1 = schema changed with
// no new migration (entity files listed). Exit 2 = could not determine the base commit.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const TARGET_BRANCH = process.env.GITLAB_TARGET_BRANCH || "dev";
const ENTITY_FILE = new RegExp(process.env.SCHEMA_CHECK_ENTITY_RE || "\\.entity\\.ts$");
const MIGRATION_FILE = new RegExp(process.env.SCHEMA_CHECK_MIGRATION_RE || "(^|/)migrations/.+\\.[jt]s$");
const SCHEMA_DECORATOR =
  /@(Entity|Column|PrimaryColumn|PrimaryGeneratedColumn|CreateDateColumn|UpdateDateColumn|DeleteDateColumn|VersionColumn|Generated|ManyToOne|OneToOne|ManyToMany|JoinColumn|JoinTable|Index|Unique|Check|Exclusion)\s*\(/;

const cwd = process.cwd();
const log = (line) => console.log(`[schema-check] ${line}`);

function git(args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1024 * 1024 * 200 });
}

function tryGit(args) {
  try {
    return git(args);
  } catch {
    return null;
  }
}

const base =
  tryGit(["merge-base", "HEAD", `origin/${TARGET_BRANCH}`])?.trim() ?? tryGit(["merge-base", "HEAD", TARGET_BRANCH])?.trim();
if (!base) {
  log(`не нашёл общий коммит с ${TARGET_BRANCH} — проверить нечем`);
  process.exit(2);
}

// name-status against the base covers committed and uncommitted work alike; untracked
// files are new by definition.
const tracked = git(["diff", "--name-status", "--no-renames", base])
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const [status, ...path] = line.split("\t");
    return { status, path: path.join("\t") };
  });
const untracked = (tryGit(["ls-files", "--others", "--exclude-standard"]) ?? "").split("\n").filter(Boolean);

const added = new Set([...tracked.filter((f) => f.status === "A").map((f) => f.path), ...untracked]);
const migrations = [...added].filter((f) => MIGRATION_FILE.test(f));

const changedEntities = [];
for (const { status, path } of tracked) {
  if (!ENTITY_FILE.test(path) || untracked.includes(path)) continue;
  const diff = git(["diff", "--unified=0", base, "--", path]);
  const touched = diff
    .split("\n")
    .filter((l) => (l.startsWith("+") && !l.startsWith("+++")) || (l.startsWith("-") && !l.startsWith("---")))
    .filter((l) => SCHEMA_DECORATOR.test(l));
  if (touched.length > 0) changedEntities.push({ path, status, lines: touched.slice(0, 5) });
}
for (const path of untracked) {
  if (!ENTITY_FILE.test(path)) continue;
  const text = readFileSync(join(cwd, path), "utf8");
  if (SCHEMA_DECORATOR.test(text)) changedEntities.push({ path, status: "A", lines: ["(новый файл сущности)"] });
}

if (changedEntities.length === 0) {
  log("схема сущностей не менялась — миграция не нужна");
  process.exit(0);
}
if (migrations.length > 0) {
  log(`схема менялась в ${changedEntities.length} файл(ах), миграция есть: ${migrations.join(", ")}`);
  process.exit(0);
}

console.log("СХЕМА БАЗЫ ИЗМЕНЕНА БЕЗ МИГРАЦИИ");
console.log("");
console.log("These entity files change the database schema, but the change adds no migration:");
for (const e of changedEntities) {
  console.log(`- ${e.path}`);
  for (const l of e.lines) console.log(`    ${l.trim().slice(0, 160)}`);
}
console.log("");
console.log("Without a migration the column/table does not exist in any real database, and every");
console.log("query that touches it fails at runtime — unit tests with a mocked database do not show it.");
console.log("Add a migration next to the existing ones (same naming, timestamp later than the latest,");
console.log("idempotent DDL like the neighbouring migrations) that makes exactly this schema change.");
console.log("If a change really needs no migration (e.g. only a decorator's comment-level option),");
console.log("revert that decorator line to how the target branch has it.");
process.exit(1);
