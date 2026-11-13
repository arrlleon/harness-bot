import { test } from "node:test";
import assert from "node:assert/strict";
import { ChatLog, buildAssistantPrompt, parseAssistantReply, ticketKeysIn } from "./assistant.js";
import type { LiveState } from "./liveState.js";

const idle = { botRunning: true, currentJob: null, analyzing: null, pendingApproval: null, pendingHumanReview: null, pendingBrief: null } as unknown as LiveState;

test("parseAssistantReply: plain answer, no action", () => {
  assert.deepEqual(parseAssistantReply("Да, защита уже стоит на dev."), { reply: "Да, защита уже стоит на dev.", action: undefined });
});

test("parseAssistantReply takes the action from the last ДЕЙСТВИЕ line and keeps it out of the reply", () => {
  const r = parseAssistantReply('Беру, с твоим указанием.\nДЕЙСТВИЕ: {"type":"propose","key":"xen-541","repo":"backend","note":"запрети удаление для add_only"}');
  assert.equal(r.reply, "Беру, с твоим указанием.");
  assert.deepEqual(r.action, { type: "propose", key: "XEN-541", repo: "backend", note: "запрети удаление для add_only" });
  assert.deepEqual(parseAssistantReply('ДЕЙСТВИЕ: {"type":"status"}'), { reply: "", action: { type: "status" } });
});

// A wrong command is worse than none.
test("parseAssistantReply drops a malformed or unknown action but keeps the text", () => {
  assert.equal(parseAssistantReply('Ок.\nДЕЙСТВИЕ: {"type":"discard"}').action, undefined);
  assert.equal(parseAssistantReply('Ок.\nДЕЙСТВИЕ: {"type":"propose","key":"не ключ"}').action, undefined);
  assert.equal(parseAssistantReply("Ок.\nДЕЙСТВИЕ: {broken").action, undefined);
  assert.equal(parseAssistantReply('Ок.\nДЕЙСТВИЕ: {"type":"propose","key":"XEN-1","repo":"mobile"}').action?.type, "propose");
  assert.equal((parseAssistantReply('Ок.\nДЕЙСТВИЕ: {"type":"propose","key":"XEN-1","repo":"mobile"}').action as { repo?: string }).repo, undefined);
});

test("ChatLog keeps the most recent entries and clips long ones", () => {
  const log = new ChatLog();
  for (let i = 0; i < 20; i++) log.add(i % 2 ? "bot" : "user", `m${i}`);
  log.add("bot", "x".repeat(5000));
  log.add("bot", "   ");
  const recent = log.recent();
  assert.equal(recent.length, 14);
  assert.equal(recent[0].text, "m7");
  assert.ok(recent.at(-1)!.text.length < 1900);
});

// XEN-541, live: the question was about the bot's own previous message.
test("buildAssistantPrompt carries the chat, the bot's state, the history and the new message", () => {
  const prompt = buildAssistantPrompt({
    message: "То есть задача уже сделана на деве?",
    chat: [{ from: "bot", text: "⏭ ПРОПУЩЕНО · XEN-541\nанализ кода не нашёл, что менять" }],
    live: { ...idle, pendingApproval: { issueKey: "XEN-600", repo: "backend" } } as unknown as LiveState,
    history: [{ issueKey: "XEN-381", outcome: "closed", detail: "https://x/580", costUsd: 1, timestamp: "2026-11-12T08:27:00.000Z" }],
    repos: { backend: "/repos/back", frontend: "/repos/front" },
  });
  assert.match(prompt, /БОТ: ⏭ ПРОПУЩЕНО · XEN-541/);
  assert.match(prompt, /Новое сообщение CEO: То есть задача уже сделана на деве\?/);
  assert.match(prompt, /ждёт твоего «взять в работу»: предложение по XEN-600/);
  assert.match(prompt, /XEN-381: closed/);
  assert.match(prompt, /фронтенд — \/repos\/front/);
  assert.match(prompt, /ДЕЙСТВИЕ: \{"type":"\.\.\."\}/);
});

test("ticketKeysIn: keys from the message first, else from the last chat entries", () => {
  const chat = [
    { from: "bot" as const, text: "✅ ГОТОВО · XEN-381" },
    { from: "user" as const, text: "/start" },
    { from: "bot" as const, text: "⏭ ПРОПУЩЕНО · XEN-541\n(см. TASK-113)" },
  ];
  assert.deepEqual(ticketKeysIn("То есть задача уже сделана?", chat), ["XEN-541", "TASK-113"]);
  assert.deepEqual(ticketKeysIn("а что с xen-600?", chat), ["XEN-600", "XEN-541"]);
  assert.deepEqual(ticketKeysIn("привет", []), []);
});

test("buildAssistantPrompt includes the ticket text when the conversation is about a ticket", () => {
  const prompt = buildAssistantPrompt({
    message: "это точно так?",
    chat: [],
    live: idle,
    history: [],
    repos: {},
    tickets: [{ key: "XEN-541", summary: "Полный доступ у роли «Только добавление»", description: "заблокировать эндпоинты скачивания, удаления, редактирования" }],
  });
  assert.match(prompt, /### XEN-541: Полный доступ/);
  assert.match(prompt, /заблокировать эндпоинты скачивания, удаления, редактирования/);
});
