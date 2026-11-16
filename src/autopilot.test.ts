import { test } from "node:test";
import assert from "node:assert/strict";
import { pickBriefOption, shouldAutoFix } from "./autopilot.js";
import { fixBudgetExtension } from "./queue.js";

test("pickBriefOption takes the agent's recommendation, else the first option", () => {
  assert.equal(pickBriefOption({ options: [1, 2, 3], recommendedIndex: 2 }), 2);
  assert.equal(pickBriefOption({ options: [1, 2, 3] }), 0);
  assert.equal(pickBriefOption({ options: [1, 2], recommendedIndex: 7 }), 0);
});

const limits = { maxFixes: 2, taskCapUsd: 80 };
const resumable = { reason: "max_iterations", costUsd: 30, resumeState: {} };

test("shouldAutoFix allows up to maxFixes attempts while money is left under the cap", () => {
  assert.equal(shouldAutoFix(resumable, 0, limits), true);
  assert.equal(shouldAutoFix(resumable, 1, limits), true);
  assert.equal(shouldAutoFix(resumable, 2, limits), false);
  assert.equal(shouldAutoFix({ ...resumable, costUsd: 79.5 }, 0, limits), false);
});

test("shouldAutoFix needs something to act on; a push failure is retried even at the cap", () => {
  assert.equal(shouldAutoFix({ reason: "max_iterations", costUsd: 1 }, 0, limits), false);
  assert.equal(shouldAutoFix({ reason: "push/MR failed: 403", costUsd: 85 }, 0, limits), true);
});

test("fixBudgetExtension: a fresh allowance by default, never past the task cap with one", () => {
  assert.equal(fixBudgetExtension(25, 40), 25);
  assert.equal(fixBudgetExtension(25, 40, 80), 25); // run may reach 65: a full 40 more
  assert.equal(fixBudgetExtension(70, 40, 80), 40); // run may reach 80: 10 more
  assert.equal(fixBudgetExtension(10, 40, 30), 0);
});

// XEN-541, live: both automatic fixes were spent on attempts that died on the limit.
test("shouldAutoFix never retries on the account's usage limit", () => {
  const limited = { reason: "agent_error: You've hit your session limit · resets 8:40pm (Asia/Almaty)", costUsd: 9, resumeState: {} };
  assert.equal(shouldAutoFix(limited, 0, limits), false);
  const reviewLimited = { reason: "review_blocked после 1 раунд(ов) с разработчиком: ревью не состоялось (ход завершился ошибкой: You've hit your session limit · resets 8:40pm (Asia/Almaty))", costUsd: 9, resumeState: {} };
  assert.equal(shouldAutoFix(reviewLimited, 0, limits), false);
});
