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
# Quarantine (.jest-quarantine) exclusion was tried here too (CI excludes the same ~20
# known-broken suites) and DROPPED: reproduced live — passing a `--testPathIgnorePatterns`
# value with ~20 pipe-joined alternations via the jest CLI silently breaks the
# positional directory scoping entirely (jest then runs close to the FULL suite instead
# of just the scoped directories) — reproduced even with fake, harmless alternations of
# the same shape, so it's the pattern COUNT/length via CLI, not the real quarantine
# content. A real jest/yargs CLI parsing quirk in this version, not specific to this
# script. Not worth fighting for a minor nice-to-have when it silently defeats the
# actual point of this script — if a scoped run ever sweeps in one of the ~20
# quarantined suites, that's a rare, visible, investigable false-positive, not a
# systemic problem.
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
  | sed -E 's#^src/##; s#/[^/]+$##' | sort -u | tr '\n' ' ')"

if [ -z "$DIRS" ]; then
  echo "[scoped-test] nothing changed yet relative to $BASE — nothing to test"
  exit 0
fi

echo "[scoped-test] scoping to directories: $DIRS"
exec yarn jest --ci --bail=5 --maxWorkers=75% $DIRS
