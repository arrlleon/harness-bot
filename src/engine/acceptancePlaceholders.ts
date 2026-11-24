// An acceptance test is frozen before the fix and the developer may not touch it, so an
// empty `test.skip(...)` placeholder in it stays in the merge request for good. The
// acceptance prompt used to ask for exactly that for any criterion a test can't check
// (tsc, eslint, "tests were added"), and every acceptance file from XEN-1023 to XEN-1111
// carried one that had to be removed by hand. Such criteria are the gates' job.
const PLACEHOLDER = /\b(?:it|test|describe)\.(?:skip|todo)\s*\(|\bx(?:it|test|describe)\s*\(/g;

// 1-based line numbers of skip/todo placeholders in a test file's source.
export function findPlaceholderTests(source: string): number[] {
  const lines: number[] = [];
  source.split("\n").forEach((line, i) => {
    if (line.trim().startsWith("//") || line.trim().startsWith("*")) return;
    PLACEHOLDER.lastIndex = 0;
    if (PLACEHOLDER.test(line)) lines.push(i + 1);
  });
  return lines;
}

export function buildRemovePlaceholdersPrompt(relPath: string, lines: number[]): string {
  return [
    `В ${relPath} остались заглушки test.skip / it.todo (строки ${lines.join(", ")}).`,
    "Удали их целиком вместе с пояснительными комментариями к ним. Критерий, который",
    "тест проверить не может (tsc, eslint, сборка, «тесты добавлены»), проверяют гейты:",
    "в приёмочном файле ему места нет. Остальное в файле не меняй.",
  ].join("\n");
}
