import { getWorktreeDiff } from "./git.js";

export interface GateIntegrityViolation {
  description: string;
}

// Mechanical, not LLM-judgment-based — the whole point is that an agent can't argue
// its way around this the way it might around a review turn. Deliberately coarse
// (touching the file at all is enough for CI/gate-config, not "does this specific line
// look malicious") because the only legitimate reason implement should ever touch these
// during a task is essentially none: gate config and CI aren't part of fixing a ticket.
const CI_CONFIG_GLOB = /(^|\/)(\.gitlab-ci\.ya?ml|\.github\/workflows\/.*\.ya?ml)$/;
// tsconfig* and .jest-quarantine are gate config in practice: loosening `strict` or
// adding a suite to the quarantine list turns a red gate green without fixing anything.
const GATE_CONFIG_GLOB =
  /(^|\/)(jest\.config\.[cm]?[jt]s|jest-[\w-]+\.json|vitest\.config\.[cm]?[jt]s|\.eslintrc(\.[cm]?js|\.json|\.ya?ml)?|eslint\.config\.[cm]?[jt]s|tsconfig[\w.-]*\.json|\.jest-quarantine|\.eslintignore)$/;
const PACKAGE_JSON = /(^|\/)package\.json$/;
const GATE_SCRIPT_KEY = /"(test|lint|build|typecheck)"\s*:/;
// Jest/Vitest config living inside package.json (back-ai keeps its whole jest config
// there) — the keys that decide WHICH tests run or how they're resolved.
const PACKAGE_TEST_CONFIG_KEY =
  /"(jest|vitest|testRegex|testMatch|testPathIgnorePatterns|modulePathIgnorePatterns|collectCoverageFrom|moduleNameMapper|transformIgnorePatterns|rootDir|roots|bail|passWithNoTests)"\s*:/;
const TEST_FILE_GLOB = /(\.(test|spec)\.[jt]sx?$)|(^|\/)__tests__\//;
// `.only` belongs here as much as `.skip`: one `it.only` silently drops every other
// test in the file while the suite still reports green.
const SKIP_MARKER = /\.(skip|todo|only)\(|\b[xf](describe|it|test)\(/;

// The acceptance-test-writer role is explicitly told to use test.skip(...) for a
// criterion that genuinely isn't automatable (buildAcceptanceTestPrompt, engine/
// acceptanceTest.ts: "если критерий технически не проверяем автоматическим тестом,
// напиши test.skip(...) с комментарием почему") — a frozen, human-approved contract
// the implement role can't even edit (its own path is in extraDeniedPaths). Reproduced
// live (2026-11-10): every task whose acceptance criteria include a plain "tsc/build
// passes" item (close to all of them) got this exact test.skip() by design, and used to
// get flagged as if implement had weakened a test — gate_integrity_violation fired on
// sanctioned, expected content, not a real attempt to cheat a gate. Only this one known
// path is exempt; test.skip/todo added anywhere else (an EXISTING test file implement
// touched, say) still flags exactly as before.
export function parseGateIntegrityViolations(diff: string, acceptanceTestPath?: string): GateIntegrityViolation[] {
  if (!diff) return [];

  const violations: GateIntegrityViolation[] = [];
  const flaggedConfigFiles = new Set<string>();
  const flaggedScripts = new Set<string>();
  const flaggedSkipFiles = new Set<string>();
  let currentFile: string | null = null;
  let renamedFrom: string | null = null;

  for (const line of diff.split("\n")) {
    const fileMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (fileMatch) {
      currentFile = fileMatch[2];
      continue;
    }
    if (!currentFile) continue;

    if (line.startsWith("deleted file mode") && TEST_FILE_GLOB.test(currentFile)) {
      violations.push({ description: `удалён тестовый файл: ${currentFile}` });
      continue;
    }

    // A test file renamed to something the runner no longer picks up is a deletion in
    // everything but name.
    if (line.startsWith("rename from ")) {
      renamedFrom = line.slice("rename from ".length);
      continue;
    }
    if (line.startsWith("rename to ")) {
      const to = line.slice("rename to ".length);
      if (renamedFrom && TEST_FILE_GLOB.test(renamedFrom) && !TEST_FILE_GLOB.test(to)) {
        violations.push({ description: `тестовый файл переименован так, что перестал быть тестом: ${renamedFrom} → ${to}` });
      }
      renamedFrom = null;
      continue;
    }

    const added = line.startsWith("+") && !line.startsWith("+++");
    const removed = line.startsWith("-") && !line.startsWith("---");
    // Config files are flagged on ANY change — deleting a line from a jest config
    // weakens it just as well as adding one. Everything else only looks at additions.
    if (removed && (CI_CONFIG_GLOB.test(currentFile) || GATE_CONFIG_GLOB.test(currentFile))) {
      if (!flaggedConfigFiles.has(currentFile)) {
        flaggedConfigFiles.add(currentFile);
        violations.push({ description: `правка ${CI_CONFIG_GLOB.test(currentFile) ? "CI-конфига" : "конфига гейта"}: ${currentFile}` });
      }
      continue;
    }
    if (removed && PACKAGE_JSON.test(currentFile)) {
      const script = line.match(GATE_SCRIPT_KEY)?.[1];
      const key = script ?? line.match(PACKAGE_TEST_CONFIG_KEY)?.[1];
      if (key && !flaggedScripts.has(`${currentFile}:${key}`)) {
        flaggedScripts.add(`${currentFile}:${key}`);
        violations.push({ description: script ? `изменён скрипт "${key}" в ${currentFile}` : `изменён "${key}" в ${currentFile}` });
      }
      continue;
    }
    if (!added) continue;

    if (CI_CONFIG_GLOB.test(currentFile)) {
      if (!flaggedConfigFiles.has(currentFile)) {
        flaggedConfigFiles.add(currentFile);
        violations.push({ description: `правка CI-конфига: ${currentFile}` });
      }
    } else if (GATE_CONFIG_GLOB.test(currentFile)) {
      if (!flaggedConfigFiles.has(currentFile)) {
        flaggedConfigFiles.add(currentFile);
        violations.push({ description: `правка конфига гейта: ${currentFile}` });
      }
    } else if (PACKAGE_JSON.test(currentFile)) {
      const scriptMatch = line.match(GATE_SCRIPT_KEY);
      const configMatch = line.match(PACKAGE_TEST_CONFIG_KEY);
      if (scriptMatch) {
        const key = `${currentFile}:${scriptMatch[1]}`;
        if (!flaggedScripts.has(key)) {
          flaggedScripts.add(key);
          violations.push({ description: `изменён скрипт "${scriptMatch[1]}" в ${currentFile}` });
        }
      } else if (configMatch) {
        const key = `${currentFile}:${configMatch[1]}`;
        if (!flaggedScripts.has(key)) {
          flaggedScripts.add(key);
          violations.push({ description: `изменён "${configMatch[1]}" в ${currentFile}` });
        }
      }
    } else if (TEST_FILE_GLOB.test(currentFile) && currentFile !== acceptanceTestPath && SKIP_MARKER.test(line)) {
      if (!flaggedSkipFiles.has(currentFile)) {
        flaggedSkipFiles.add(currentFile);
        violations.push({ description: `добавлен skip/only/todo в тест: ${currentFile}` });
      }
    }
  }

  return violations;
}

// Runs on the diff a green gate result was built on — a baseline-relative gate can be
// fooled by an agent that skips a previously-failing test instead of fixing it (failure
// count genuinely drops, "no worse than before" is technically true, and nothing was
// actually fixed). This catches exactly that class, plus the agent editing the judge
// itself (CI config, gate commands) to make failures disappear.
export async function checkGateIntegrity(worktreeDir: string, baseBranch: string, acceptanceTestPath?: string): Promise<GateIntegrityViolation[]> {
  // No .catch here on purpose: a diff that can't be read used to become "" and so "no
  // violations" — the check silently passing exactly when it couldn't look.
  const diff = await getWorktreeDiff(worktreeDir, baseBranch);
  return parseGateIntegrityViolations(diff, acceptanceTestPath);
}
