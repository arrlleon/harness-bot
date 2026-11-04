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
const GATE_CONFIG_GLOB =
  /(^|\/)(jest\.config\.[cm]?[jt]s|vitest\.config\.[cm]?[jt]s|\.eslintrc(\.[cm]?js|\.json|\.ya?ml)?|eslint\.config\.[cm]?[jt]s)$/;
const PACKAGE_JSON = /(^|\/)package\.json$/;
const GATE_SCRIPT_KEY = /"(test|lint|build|typecheck)"\s*:/;
const TEST_FILE_GLOB = /(\.(test|spec)\.[jt]sx?$)|(^|\/)__tests__\//;
const SKIP_MARKER = /\.(skip|todo)\(|x(describe|it|test)\(/;

// Pure, directly testable — checkGateIntegrity below is just this plus the I/O to get
// the diff in the first place.
export function parseGateIntegrityViolations(diff: string): GateIntegrityViolation[] {
  if (!diff) return [];

  const violations: GateIntegrityViolation[] = [];
  const flaggedConfigFiles = new Set<string>();
  const flaggedScripts = new Set<string>();
  const flaggedSkipFiles = new Set<string>();
  let currentFile: string | null = null;

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

    if (!line.startsWith("+") || line.startsWith("+++")) continue;

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
      if (scriptMatch) {
        const key = `${currentFile}:${scriptMatch[1]}`;
        if (!flaggedScripts.has(key)) {
          flaggedScripts.add(key);
          violations.push({ description: `изменён скрипт "${scriptMatch[1]}" в ${currentFile}` });
        }
      }
    } else if (TEST_FILE_GLOB.test(currentFile) && SKIP_MARKER.test(line)) {
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
export async function checkGateIntegrity(worktreeDir: string, baseBranch: string): Promise<GateIntegrityViolation[]> {
  const diff = await getWorktreeDiff(worktreeDir, baseBranch).catch(() => "");
  return parseGateIntegrityViolations(diff);
}
