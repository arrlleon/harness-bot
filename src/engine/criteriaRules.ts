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
];

const CURRENT_BEHAVIOUR_CLAIM =
  /не\s+меня(?:ется|ются)|без\s+изменени|по-прежнему|как\s+(?:сейчас|раньше)|продолжа(?:ет|ют)|не\s+регресс/i;

// 1-based numbers of the criteria that claim some behaviour stays as it is. Exactly the
// kind the analysis got wrong (XEN-1025); the proposal asks the human to check these.
export function currentBehaviourClaims(criteria: string[]): number[] {
  return criteria.flatMap((c, i) => (CURRENT_BEHAVIOUR_CLAIM.test(c) ? [i + 1] : []));
}
