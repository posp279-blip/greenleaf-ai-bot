import assert from "node:assert/strict";
import test from "node:test";
import {
  VkEventDeduplicator,
  buildVkKeyboard,
  chooseReferralCode,
  evaluateVkCallback,
  extractCallbackData,
  extractReferralCode,
  fromVkSyntheticUserId,
  normalizeVkMessageText,
  sanitizeReferralCode,
  toVkSyntheticUserId,
} from "./protocol.js";

test("VK confirmation returns configured code", () => {
  assert.deepEqual(
    evaluateVkCallback(
      { type: "confirmation", group_id: 10, secret: "secret" },
      { callbackSecret: "secret", confirmationCode: "confirm123", groupId: 10 },
    ),
    { status: 200, body: "confirm123", shouldHandle: false },
  );
});

test("invalid VK secret and group are rejected", () => {
  assert.equal(
    evaluateVkCallback(
      { type: "message_new", group_id: 10, secret: "wrong" },
      { callbackSecret: "secret", confirmationCode: "code", groupId: 10 },
    ).status,
    403,
  );

  assert.equal(
    evaluateVkCallback(
      { type: "message_new", group_id: 11, secret: "secret" },
      { callbackSecret: "secret", confirmationCode: "code", groupId: 10 },
    ).status,
    403,
  );
});

test("message_new is acknowledged and scheduled", () => {
  assert.deepEqual(
    evaluateVkCallback(
      { type: "message_new", group_id: 10, secret: "secret" },
      { callbackSecret: "secret", confirmationCode: "code", groupId: 10 },
    ),
    { status: 200, body: "ok", shouldHandle: true },
  );
});

test("VK event deduplication ignores the same event id within TTL", () => {
  const deduplicator = new VkEventDeduplicator(1000);
  assert.equal(deduplicator.shouldProcess("event-1", 100), true);
  assert.equal(deduplicator.shouldProcess("event-1", 200), false);
  assert.equal(deduplicator.shouldProcess("event-1", 1200), true);
  assert.equal(deduplicator.shouldProcess(undefined, 1200), true);
});

test("VK and Telegram numeric ids cannot collide", () => {
  assert.equal(toVkSyntheticUserId(12345), -12345);
  assert.equal(fromVkSyntheticUserId(-12345), 12345);
  assert.equal(fromVkSyntheticUserId(12345), null);
  assert.notEqual(toVkSyntheticUserId(12345), 12345);
});

test("referral code is extracted and first valid sponsor wins", () => {
  const body = {
    type: "message_new",
    object: { message: { from_id: 1, ref: "partner_125" } },
  };
  const message = body.object.message;
  assert.equal(extractReferralCode(body, message), "partner_125");
  assert.equal(chooseReferralCode(null, "partner_125", true), "partner_125");
  assert.equal(chooseReferralCode("first_partner", "second_partner", true), "first_partner");
  assert.equal(chooseReferralCode(null, "missing", false), undefined);
});

test("invalid referral codes are rejected without throwing", () => {
  assert.equal(sanitizeReferralCode("valid-code_1"), "valid-code_1");
  assert.equal(sanitizeReferralCode("bad code"), undefined);
  assert.equal(sanitizeReferralCode("<script>"), undefined);
  assert.equal(extractReferralCode({ object: { message: { ref: "bad code" } } }, { ref: "bad code" }), undefined);
});

test("VK button payload is parsed and partner actions can be hidden", () => {
  assert.equal(extractCallbackData(JSON.stringify({ callback_data: "v2_start" })), "v2_start");

  const keyboard = buildVkKeyboard({
    inline_keyboard: [
      [{ text: "Начать", callback_data: "v2_start" }],
      [{ text: "Моя ссылка", callback_data: "partner_link" }],
    ],
  }, false);

  assert.equal(keyboard?.inline, true);
  assert.equal(keyboard?.buttons.length, 1);
  assert.equal(keyboard?.buttons[0]?.[0]?.action.label, "Начать");
  assert.equal(keyboard?.buttons[0]?.[0]?.color, "positive");
});

test("VK reply keyboard menu button opens the shared main menu", () => {
  const keyboard = buildVkKeyboard({
    keyboard: [[{ text: "☰ Меню" }]],
  }, false);

  const payload = keyboard?.buttons[0]?.[0]?.action.payload;
  assert.equal(keyboard?.inline, false);
  assert.equal(keyboard?.one_time, false);
  assert.equal(extractCallbackData(payload), "menu_main");
  assert.equal(
    extractCallbackData(JSON.stringify({ callback_data: "☰ Меню" })),
    "menu_main",
  );
});

test("VK messages without explicit buttons keep the persistent menu", () => {
  const keyboard = buildVkKeyboard(undefined, false);
  const button = keyboard?.buttons[0]?.[0];

  assert.equal(keyboard?.inline, false);
  assert.equal(keyboard?.one_time, false);
  assert.equal(button?.action.label, "☰ Меню");
  assert.equal(extractCallbackData(button?.action.payload), "menu_main");
});

test("shared VK main menu is converted to a persistent bottom keyboard", () => {
  const keyboard = buildVkKeyboard({
    inline_keyboard: [
      [{ text: "Продолжить", callback_data: "menu_continue" }],
      [
        { text: "Моя заявка", callback_data: "menu_my_lead" },
        { text: "Задать вопрос", callback_data: "menu_question" },
      ],
      [{ text: "Моя ссылка", callback_data: "partner_link" }],
    ],
  }, true);

  assert.equal(keyboard?.inline, false);
  assert.equal(keyboard?.one_time, false);
  assert.equal(keyboard?.buttons.length, 3);
  assert.equal(
    extractCallbackData(keyboard?.buttons[2]?.[0]?.action.payload),
    "partner_link",
  );
});

test("Telegram HTML is converted to readable VK text", () => {
  const formatted = [
    "<b>📊 СРАВНЕНИЕ РАСХОДОВ ЗА ГОД</b>",
    "<b>🧺 Стирка белья</b>",
    "🏪 Масс-маркет: <b>1 500 ₽</b>",
    "<i>Расчёт примерный &amp; зависит от цен.</i>",
    '<a href="https://example.com">Подробнее</a>',
  ].join("\n");

  assert.equal(
    normalizeVkMessageText(formatted),
    [
      "📊 СРАВНЕНИЕ РАСХОДОВ ЗА ГОД",
      "🧺 Стирка белья",
      "🏪 Масс-маркет: 1 500 ₽",
      "Расчёт примерный & зависит от цен.",
      "Подробнее (https://example.com)",
    ].join("\n"),
  );
});
