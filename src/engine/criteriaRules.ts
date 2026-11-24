// Rules for the acceptance criteria a propose turn writes. The criteria are frozen into
// an acceptance test the developer may not change, so a wrong one is carried out to the
// letter. Three ways it went wrong live:
// - XEN-1025: "the author keeps downloading regardless of the folder — no change", while
//   the code refused the author; the frozen test then demanded widening the access.
// - XEN-1111: the route rule narrowed to "active or already processed" steps, while the
//   server's own check ignores the step status.
// - XEN-1023/1026/1111: process criteria ("tsc and eslint pass") the acceptance writer
//   could only fill with empty test.skip placeholders.
export const CRITERIA_RULES: string[] = [
  "Правила для критериев (их заморозят в тест, который разработчику менять нельзя):",
  "- Любое утверждение о ТЕКУЩЕМ поведении («не меняется», «как сейчас», «по-прежнему»,",
  "  «продолжает») сначала проверь по коду. Если код сейчас ведёт себя иначе, так и напиши:",
  "  это изменение поведения, а не его сохранение.",
  "- Правило доступа (кто что видит, скачивает, меняет) формулируй так же, как его уже",
  "  проверяет код: найди эту проверку и назови её. Не сужай и не расширяй его своими",
  "  словами (например, не ограничивай шаги маршрута статусом, если проверка статус не смотрит).",
  "- Не пиши критерии про процесс (tsc, eslint, сборка, «тесты добавлены»): их проверяют гейты.",
  "- Найди все места с той же проверкой или тем же поведением, что чинит задача: вызовы той же",
  "  функции-проверки (Grep), соседние эндпоинты, кнопки и страницы с тем же правилом, и всё, что",
  "  тикет называет в блоке «Для разработчика». Каждое место, которое должно измениться, — отдельный",
  "  критерий; остальные назови в плане с причиной, почему их не трогаешь.",
];

const CURRENT_BEHAVIOUR_CLAIM =
  /не\s+меня(?:ется|ются)|без\s+изменени|по-прежнему|как\s+(?:сейчас|раньше)|продолжа(?:ет|ют)|не\s+регресс/i;

// 1-based numbers of the criteria that claim some behaviour stays as it is. Exactly the
// kind the analysis got wrong (XEN-1025); the proposal asks the human to check these.
export function currentBehaviourClaims(criteria: string[]): number[] {
  return criteria.flatMap((c, i) => (CURRENT_BEHAVIOUR_CLAIM.test(c) ? [i + 1] : []));
}

// Places the ticket names as code — Jira {{monospace}} that looks like a file or an
// endpoint ("client/documents/page.tsx", "GET /documents/feed") — which neither the plan
// nor the criteria mention. A fix that covers the literal ask and misses a sibling place
// the ticket itself pointed at is how XEN-1026 (the batch link) and XEN-1111 (the card's
// copy link) came back half-done; the proposal shows these for the human to check.
export function ticketPlacesMissingFromPlan(description: string, planAndCriteria: string): string[] {
  const haystack = planAndCriteria.toLowerCase();
  const refs = [...description.matchAll(/\{\{([^}]+)\}\}/g)].map((m) => m[1].trim());
  // A path or an endpoint, not an expression: "canX(doc.folderId / batch.folderId)" has a
  // slash too, but it's code the plan describes in words, not a place to visit.
  const isPlace = (r: string) =>
    !/[()]/.test(r) &&
    (/\.(?:tsx?|jsx?|vue|py|sql)\b/.test(r) || /^(?:(?:GET|POST|PUT|PATCH|DELETE)\s+)?\/?[\w.\-[\]:]+\/[\w.\-[\]/:]*$/.test(r));
  const places = refs.filter(isPlace);
  // Matched on the last two path segments: "page.tsx" alone is in every Next.js plan, while
  // "documents/page.tsx" and "[id]/page.tsx" are different pages.
  const missing = places.filter((r) => {
    const segments = r.replace(/^(?:GET|POST|PUT|PATCH|DELETE)\s+/, "").split("/").filter(Boolean);
    const key = segments.slice(-2).join("/");
    return !haystack.includes(key.toLowerCase());
  });
  return [...new Set(missing)];
}
