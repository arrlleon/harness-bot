#!/bin/sh
# Scoped test gate for back-ai.
#
# XEN-541 (2026-11-10): the baseline "test" gate — a bare `yarn test`, back-ai's full
# 1211-file .spec.ts suite — took 45+ minutes, and runs on EVERY iteration (baseline
# once, then again after every fix attempt, up to MAX_ITERATIONS).
#
# First attempt used `jest --findRelatedTests <changed files>` — jest's own
# dependency-graph traversal. Reproduced live: one touched file (folders.service.ts)
# pulled in 275+ unrelated suites across legal/fleet/egov/multi-documents (NestJS's own
# DI wiring creates heavy fan-in — many modules transitively import a shared
# llm-router), taking as long as the full suite with none of the safety.
#
# This version scopes by DIRECTORY instead: every changed .ts file's own containing
# directory (relative to src/), deduped, passed to jest as plain path-regex arguments
# — jest's positional args are a path-pattern match, not a dependency walk, so the
# scope is bounded to exactly "this ticket's own touched module(s)", nothing
# transitively reachable from them. Narrower safety net than the full suite (a
# regression in an unrelated, untouched directory won't be caught here) — an accepted,
# explicit tradeoff for the speed, not an oversight.
#
# Quarantine (.jest-quarantine) exclusion, and later unit-vs-integration filtering,
# were both tried via `--testPathIgnorePatterns` (CI excludes quarantine the same way)
# and DROPPED: reproduced live — ANY value passed to `--testPathIgnorePatterns` via the
# jest CLI silently breaks positional scoping entirely (jest then runs close to the
# FULL suite instead of just the scoped set) — reproduced with the real ~20-pattern
# quarantine string, a single fake pattern, and a single real one; it's the flag itself
# in this jest/yargs version's CLI parsing, not pattern count or content. Worked around
# below by enumerating the actual files to run ourselves (find, with its own
# exclusions) instead of handing jest a directory + an ignore list.
#
# "Only unit tests" (2026-11-10, explicit user request): excludes this project's own
# *.integration.spec.ts naming convention (real DB/infra-backed tests — e.g. the
# `.pg.integration.spec.ts` suffix) from the scoped set. Narrower still than the
# directory-scoping tradeoff already accepted above.
#
# This gate is configured `strict: true` (BACKEND_TEST_STRICT=true in .env): a
# diff-scoped baseline is always vacuously empty (nothing's changed yet at baseline
# time, and establishBaselines skips strict gates entirely — see verify.ts), so there's
# no real "N pre-existing failures to tolerate" to compare future scoped runs against.
# Same reasoning as the acceptance-test gate.
#
# --bail=5: stop once 5 suites have failed rather than grinding through the rest of
# the scoped set — most iterations where the fix isn't done yet fail fast and
# repeatedly; no need to wait out the whole scoped run to learn that again. 5, not 1,
# keeps enough simultaneous findings for one combined fix pass (same reasoning as
# runGates reporting every gate together) without the unbounded worst case.
# --maxWorkers=75%: CI uses 50% (a shared runner, deliberately conservative); this
# machine is single-tenant with 8 cores, so a less conservative cap still leaves
# headroom without needlessly serializing.
set -e

git fetch origin dev >/dev/null 2>&1 || true
BASE="$(git merge-base HEAD origin/dev 2>/dev/null)" || BASE=""

if [ -z "$BASE" ]; then
  echo "[scoped-test] no merge-base against origin/dev — falling back to the full suite"
  exec yarn jest --ci --bail=5 --maxWorkers=75%
fi

DIRS="$(git diff --name-only --diff-filter=ACMR "$BASE" -- '*.ts' \
  | sed -E 's#^src/##; s#/[^/]+$##' | sort -u)"

if [ -z "$DIRS" ]; then
  echo "[scoped-test] nothing changed yet relative to $BASE — nothing to test"
  exit 0
fi

FILES=""
for dir in $DIRS; do
  FILES="$FILES
$(find "src/$dir" -name '*.spec.ts' ! -name '*.integration.spec.ts' 2>/dev/null)"
done
FILES="$(echo "$FILES" | grep -v '^$' | sort -u | tr '\n' ' ')"

if [ -z "$FILES" ]; then
  echo "[scoped-test] no unit test files found under: $(echo "$DIRS" | tr '\n' ' ')"
  exit 0
fi

echo "[scoped-test] scoping to unit tests: $FILES"
exec yarn jest --ci --bail=5 --maxWorkers=75% $FILES
