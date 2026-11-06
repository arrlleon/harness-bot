// Real secret leak path once buildAgentEnv() keeps the spawned `claude` process from
// ever reading JIRA_PAT/GITLAB_TOKEN/TELEGRAM_BOT_TOKEN out via Bash: a read-only role
// (memory/review/testing-notes) that reads a file, log, or diff containing a real
// secret can still copy it straight into the free-text it returns — and that text gets
// committed into the repo's own memory file, posted as a Jira comment, or embedded in
// an MR description. Modeled on Avengers Harness's own two-layer scrub: exact known
// values first (by name, zero false positives), then rigid secret SHAPES the harness
// doesn't already know the value of (a sample token in a ticket, a key in a fixture).

// Secrets under this length are skipped — an unset var or a trivial local placeholder
// would otherwise turn into a global find-and-replace over ordinary short strings.
const MIN_KNOWN_SECRET_LENGTH = 6;

export function scrubKnownSecrets(text: string, knownSecrets: Record<string, string>): string {
  let result = text;
  for (const [name, value] of Object.entries(knownSecrets)) {
    if (value.length < MIN_KNOWN_SECRET_LENGTH) continue;
    result = result.split(value).join(`***cred:${name}***`);
  }
  return result;
}

// Deliberately narrow to rigid, low-false-positive formats — not "password=" style
// prose, which would mangle legitimate review/memory text about renaming a field.
const HEURISTIC_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "bearer-token", pattern: /\bBearer\s+[A-Za-z0-9\-._~+/]{10,}=*/gi },
  { name: "pem-block", pattern: /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
];

export function scrubSecretShapes(text: string): string {
  let result = text;
  for (const { name, pattern } of HEURISTIC_PATTERNS) {
    result = result.replace(pattern, `***redacted:${name}***`);
  }
  return result;
}

// Known-value pass runs first: a configured secret that happens to be JWT-shaped (some
// Jira/GitLab PATs are) is redacted by name, not swallowed by the generic JWT pattern.
export function scrubSecrets(text: string, knownSecrets: Record<string, string>): string {
  return scrubSecretShapes(scrubKnownSecrets(text, knownSecrets));
}
