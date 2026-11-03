// Mechanical (not just prompt-based) limits on what the agent can touch,
// matching DEVBOT's own instinct: migrations/CI/secrets stay out of a model's
// hands regardless of what the task asks for. Enforced via Claude Code's own
// --disallowedTools path patterns, verified live: a denied path is refused at
// the tool-call level, the agent reports it couldn't touch it, and moves on.
export const DEFAULT_DENIED_PATHS = [
  "**/migrations/**",
  "**/.env*",
  "**/.gitlab-ci.yml",
  "**/.github/workflows/**",
  "**/yarn.lock",
  "**/package-lock.json",
  "**/pnpm-lock.yaml",
  "**/*.pem",
  "**/*.key",
];

export function buildDisallowedTools(extraDeniedPaths: string[] = []): string {
  const paths = [...DEFAULT_DENIED_PATHS, ...extraDeniedPaths];
  const pathRules = paths.flatMap((p) => [`Edit(${p})`, `Write(${p})`]);
  return ["Bash", ...pathRules].join(",");
}
