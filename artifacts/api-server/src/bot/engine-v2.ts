import TelegramBot from "node-telegram-bot-api";
import type { CallbackQuery, InlineKeyboardButton, Message } from "node-telegram-bot-api";
import { db } from "@workspace/db";
import {
  adminStateTable,
  appSettingsTable,
  calculatorItemsTable,
  leadsTable,
  messagesTable,
  partnersTable,
  userSessionsTable,
  videoBlocksTable,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import { answerQuestion, classifyUserInput } from "./ai.js";
import { classifyText, detectBrandName, type Intent } from "./classifier.js";
import { getV2Text } from "./content-store-v2.js";
import {
  extractFirstName,
  isAccidentalShortInput,
  isAffirmative,
  isEarningsQuestion,
  isNameRefusal,
  isNegative,
  isValidContact,
  normalizeContact,
  parseFamilyProfile,
  wantsToSkip,
} from "./flow-v2.js";
import {
  handleAdminCallback as legacyHandleAdminCallback,
  handleCallback as legacyHandleCallback,
  handleMessage as legacyHandleMessage,
} from "./engine.js";
import {
  makeQuestionStage,
  normalizeStoredStage,
  parseQuestionStage,
  type V2Stage,
} from "./stages-v2.js";

export const handleAdminCallback = legacyHandleAdminCallback;

type BotSession = typeof userSessionsTable.$inferSelect;
type Partner = typeof partnersTable.$inferSelect;

type Calculation = {
  familyLabel: string;
  multiplier: number;
  mass: number;
  green: number;
  saving: number;
  items: Array<{
    category: string;
    mass: number;
    green: number;
    saving: number;
  }>;
};

const ADMIN_CACHE_TTL_MS = 60_000;
let adminCache: { ids: number[]; expiresAt: number } | null = null;

const REPLY_ACTIONS: Record<string, string> = {
  "☰ Меню": "menu_main",
};

const V2_CALLBACKS = new Set([
  "v2_start",
  "menu_main",
  "menu_continue",
  "menu_calc",
  "menu_question",
  "menu_my_lead",
  "menu_contact",
  "restart_confirm",
]);

function getReplyKeyboard() {
  return { keyboard: [[{ text: "☰ Меню" }]], resize_keyboard: true };
}

async function getSetting(key: string): Promise<string> {
  const rows = await db
    .select({ value: appSettingsTable.value })
    .from(appSettingsTable)
    .where(eq(appSettingsTable.key, key))
    .limit(1);
  return rows[0]?.value || "";
}

async function getAdminIds(): Promise<number[]> {
  const now = Date.now();
  if (adminCache && adminCache.expiresAt > now) return adminCache.ids;

  const stored = await getSetting("admin_telegram_ids");
  const raw = [stored, process.env.ADMIN_TELEGRAM_IDS].filter(Boolean).join(",");
  const ids = raw
    .split(",")
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isFinite(value) && value > 0);

  adminCache = { ids, expiresAt: now + ADMIN_CACHE_TTL_MS };
  return ids;
}

async function isAdmin(userId: number): Promise<boolean> {
  return (await getAdminIds()).includes(userId);
}

async function getActivePartner(userId: number, session?: BotSession): Promise<Partner | null> {
  const currentSession = session || (await db
    .select()
    .from(userSessionsTable)
    .where(eq(userSessionsTable.telegramUserId, userId))
    .limit(1))[0];

  if (currentSession?.partnerId) {
    const partner = (await db
      .select()
      .from(partnersTable)
      .where(eq(partnersTable.id, currentSession.partnerId))
      .limit(1))[0];
    if (partner) return partner;
  }

  const active = (await db
    .select()
    .from(partnersTable)
    .where(and(eq(partnersTable.telegramUserId, userId), eq(partnersTable.isActive, true)))
    .limit(1))[0];
  if (active) return active;

  return (await db
    .select()
    .from(partnersTable)
    .where(eq(partnersTable.telegramUserId, userId))
    .limit(1))[0] || null;
}

async function getOrCreateSession(
  userId: number,
  username: string | undefined,
  _telegramFirstName: string | undefined,
  lastName: string | undefined,
  refCode?: string,
): Promise<BotSession> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${userId}::bigint)`);

    const existing = (await tx
      .select()
      .from(userSessionsTable)
      .where(eq(userSessionsTable.telegramUserId, userId))
      .limit(1))[0];

    if (existing) {
      let partnerId = existing.partnerId;
      let storedRefCode = existing.refCode;
      if (refCode && !storedRefCode) {
        const partner = (await tx
          .select({ id: partnersTable.id })
          .from(partnersTable)
          .where(and(eq(partnersTable.refCode, refCode), eq(partnersTable.isActive, true)))
          .limit(1))[0];
        partnerId = partner?.id || null;
        storedRefCode = refCode;
      }

      const [updated] = await tx
        .update(userSessionsTable)
        .set({
          username: username || existing.username,
          firstName: existing.firstName,
          lastName: lastName || existing.lastName,
          refCode: storedRefCode,
          partnerId,
          updatedAt: new Date(),
        })
        .where(eq(userSessionsTable.id, existing.id))
        .returning();
      return updated || existing;
    }

    let partnerId: number | null = null;
    if (refCode) {
      const partner = (await tx
        .select({ id: partnersTable.id })
        .from(partnersTable)
        .where(and(eq(partnersTable.refCode, refCode), eq(partnersTable.isActive, true)))
        .limit(1))[0];
      partnerId = partner?.id || null;
    }

    const [created] = await tx
      .insert(userSessionsTable)
      .values({
        telegramUserId: userId,
        username,
        firstName: null,
        lastName,
        refCode,
        partnerId,
        currentStage: "intro",
      })
      .returning();

    if (!created) throw new Error("Failed to create v2 bot session");
    return created;
  });
}

async function updateStage(sessionId: number, stage: V2Stage | string): Promise<void> {
  await db
    .update(userSessionsTable)
    .set({ currentStage: stage, updatedAt: new Date() })
    .where(eq(userSessionsTable.id, sessionId));
}

async function saveMessage(
  sessionId: number,
  role: "user" | "bot",
  content: string,
  stage: string,
  intent?: string,
): Promise<void> {
  await db.insert(messagesTable).values({ sessionId, role, content, stage, intent });
}

async function sendBotText(
  bot: TelegramBot,
  chatId: number,
  sessionId: number,
  stage: string,
  text: string,
  options: TelegramBot.SendMessageOptions = {},
): Promise<void> {
  await bot.sendMessage(chatId, text, options);
  await saveMessage(sessionId, "bot", text, stage);
}

async function sendBlock(
  bot: TelegramBot,
  chatId: number,
  session: BotSession,
  nextStage: V2Stage,
  key: Parameters<typeof getV2Text>[0],
  values: Record<string, string | number> = {},
  options: TelegramBot.SendMessageOptions = {},
): Promise<void> {
  const text = await getV2Text(key, values);
  await updateStage(session.id, nextStage);
  await sendBotText(bot, chatId, session.id, nextStage, text, options);
}

async function getVideoUrl(key: string): Promise<string | null> {
  const row = (await db
    .select({ url: videoBlocksTable.url })
    .from(videoBlocksTable)
    .where(and(eq(videoBlocksTable.key, key), eq(videoBlocksTable.isActive, true)))
    .limit(1))[0];
  return row?.url || null;
}

async function composeVideoMessage(key: string, prompt: string): Promise<string> {
  const url = await getVideoUrl(key);
  if (url) return `🎬 ${url}\n\n${prompt}`;
  return `${await getV2Text("video_placeholder")}\n\n${prompt}`;
}

async function sendIntro(bot: TelegramBot, chatId: number, session: BotSession): Promise<void> {
  const intro = await getV2Text("intro");
  const videoUrl = await getVideoUrl("intro_video");
  const video = videoUrl ? `🎬 ${videoUrl}` : await getV2Text("video_placeholder");
  const text = `${intro}\n\n${video}`;
  await updateStage(session.id, "intro");
  await sendBotText(bot, chatId, session.id, "intro", text, {
    reply_markup: {
      inline_keyboard: [[{ text: "▶️ Начать", callback_data: "v2_start" }]],
    },
  });
}

async function classifyBrandAnswer(text: string, stage: V2Stage, sessionId: number): Promise<{ intent: Intent; brandName?: string }> {
  let intent = classifyText(text);
  let brandName = detectBrandName(text) || undefined;

  if (intent === "other") {
    try {
      const ai = await classifyUserInput(text, stage, sessionId);
      if (ai.intent !== "other") intent = ai.intent as Intent;
      if (ai.brandName) brandName = ai.brandName;
    } catch (err) {
      logger.error({ err, sessionId, stage }, "V2 brand classification failed");
    }
  }

  return { intent, brandName };
}

function categoryReactionKey(
  category: "laundry" | "dish",
  intent: Intent,
): Parameters<typeof getV2Text>[0] {
  if (intent === "eco_brand") return category === "laundry" ? "laundry_reaction_eco" : "dish_reaction_eco";
  if (intent === "unknown" || intent === "not_used") return category === "laundry" ? "laundry_reaction_unknown" : "dish_reaction_unknown";
  return category === "laundry" ? "laundry_reaction_mass" : "dish_reaction_mass";
}

async function calculateForSession(session: BotSession): Promise<Calculation> {
  const items = await db
    .select()
    .from(calculatorItemsTable)
    .orderBy(calculatorItemsTable.order);

  const adults = Math.max(1, session.familyAdults || 1);
  const children = Math.max(0, session.familyChildren || 0);
  const members = Math.max(1, adults + children);
  const multiplier = members;
  const includeFemaleHygiene = session.femaleHygieneRelevant !== false;

  const activeItems = items.filter((item) => {
    if (!item.isActive) return false;
    if (!includeFemaleHygiene && /женск/i.test(item.category)) return false;
    return true;
  });

  const scaled = activeItems.map((item) => ({
    category: item.category,
    mass: item.massMarketYearPrice * multiplier,
    green: item.greenleafYearPrice * multiplier,
    saving: item.savingYear * multiplier,
  }));

  const totals = scaled.reduce(
    (acc, item) => ({
      mass: acc.mass + item.mass,
      green: acc.green + item.green,
      saving: acc.saving + item.saving,
    }),
    { mass: 0, green: 0, saving: 0 },
  );

  return {
    familyLabel: `${adults} взросл.${children ? ` и ${children} реб.` : ""}`,
    multiplier,
    ...totals,
    items: scaled,
  };
}

function formatMoney(value: number): string {
  return Math.round(value).toLocaleString("ru-RU");
}

async function sendSavingsTable(bot: TelegramBot, chatId: number, session: BotSession): Promise<void> {
  const calculation = await calculateForSession(session);
  const lines = calculation.items.map(
    (item) => `${item.category}: ${formatMoney(item.mass)} / ${formatMoney(item.green)} / ${formatMoney(item.saving)} ₽`,
  );
  const text = [
    "📊 Таблица: масс-маркет / Greenleaf / разница",
    "",
    ...lines,
    "",
    `ИТОГО: ${formatMoney(calculation.mass)} / ${formatMoney(calculation.green)} / ${formatMoney(calculation.saving)} ₽`,
    "",
    "Расчёт примерный и зависит от расхода и актуальных цен.",
  ].join("\n");
  await sendBotText(bot, chatId, session.id, session.currentStage, text);
}

async function notifyPartner(bot: TelegramBot, partnerId: number, text: string): Promise<void> {
  const partner = (await db
    .select({ telegramUserId: partnersTable.telegramUserId })
    .from(partnersTable)
    .where(eq(partnersTable.id, partnerId))
    .limit(1))[0];
  if (!partner?.telegramUserId) return;

  try {
    await bot.sendMessage(partner.telegramUserId, text);
  } catch (err) {
    logger.error({ err, partnerId }, "Failed to notify partner about v2 lead");
  }
}

async function notifyAdmins(bot: TelegramBot, text: string): Promise<void> {
  if ((await getSetting("telegram_notifications_enabled")) !== "true") return;
  for (const adminId of await getAdminIds()) {
    try {
      await bot.sendMessage(adminId, text);
    } catch (err) {
      logger.error({ err, adminId }, "Failed to notify admin about v2 lead");
    }
  }
}

async function createLead(bot: TelegramBot, session: BotSession, contact: string): Promise<void> {
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${session.id}::bigint)`);
    const fresh = (await tx
      .select()
      .from(userSessionsTable)
      .where(eq(userSessionsTable.id, session.id))
      .limit(1))[0];
    if (!fresh) throw new Error("Session disappeared during lead creation");

    if (fresh.leadId) {
      const existing = (await tx
        .select()
        .from(leadsTable)
        .where(eq(leadsTable.id, fresh.leadId))
        .limit(1))[0];
      if (existing) return { lead: existing, created: false, session: fresh };
    }

    const existingBySession = (await tx
      .select()
      .from(leadsTable)
      .where(eq(leadsTable.sessionId, fresh.id))
      .limit(1))[0];
    if (existingBySession) {
      await tx
        .update(userSessionsTable)
        .set({
          leadId: existingBySession.id,
          isCompleted: true,
          currentStage: "completed",
          completedAt: fresh.completedAt || new Date(),
          updatedAt: new Date(),
        })
        .where(eq(userSessionsTable.id, fresh.id));
      return { lead: existingBySession, created: false, session: fresh };
    }

    const [lead] = await tx
      .insert(leadsTable)
      .values({
        sessionId: fresh.id,
        partnerId: fresh.partnerId,
        name: fresh.firstName || "Пользователь",
        contact,
        comment: null,
        status: "новая",
      })
      .returning();
    if (!lead) throw new Error("Lead insert returned no row");

    await tx
      .update(userSessionsTable)
      .set({
        leadId: lead.id,
        isCompleted: true,
        currentStage: "completed",
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(userSessionsTable.id, fresh.id));

    return { lead, created: true, session: fresh };
  });

  if (!result.created) return;

  const notification = [
    "🆕 Новая заявка из Greenleaf AI Bot v2",
    "",
    `Имя: ${result.lead.name}`,
    `Контакт: ${result.lead.contact}`,
    `Дата: ${result.lead.createdAt.toLocaleString("ru-RU")}`,
  ].join("\n");

  if (result.session.partnerId) await notifyPartner(bot, result.session.partnerId, notification);
  else await notifyAdmins(bot, notification);
}

async function answerUserQuestion(
  bot: TelegramBot,
  chatId: number,
  session: BotSession,
  stage: V2Stage,
  text: string,
): Promise<void> {
  await saveMessage(session.id, "user", text, stage, "question");
  let answer: string | null = null;
  try {
    answer = await answerQuestion(text, stage, session.id);
  } catch (err) {
    logger.error({ err, sessionId: session.id, stage }, "V2 question answer failed");
  }
  const response = answer || await getV2Text("question_fallback");
  await sendBotText(bot, chatId, session.id, stage, response);
}

function topicForStage(stage: V2Stage): string {
  if (stage.startsWith("laundry")) return "стирка";
  if (stage.startsWith("dish")) return "средство для посуды";
  if (stage.startsWith("pads")) return "женская гигиена";
  if (stage.startsWith("toilet")) return "туалетная бумага";
  if (stage.startsWith("family")) return "семейный расчёт";
  if (stage.includes("model")) return "модель 3 по 3";
  return "текущий этап";
}

async function sendCurrentPrompt(bot: TelegramBot, chatId: number, session: BotSession): Promise<void> {
  const stage = normalizeStoredStage(session.currentStage);
  if (stage === "intro") {
    await sendIntro(bot, chatId, session);
    return;
  }

  const keyByStage: Partial<Record<V2Stage, Parameters<typeof getV2Text>[0]>> = {
    name_question: "name_question",
    laundry_brand: session.firstName ? "laundry_question_named" : "laundry_question_anonymous",
    laundry_permission: "laundry_reaction_unknown",
    laundry_video_permission: "laundry_explanation",
    laundry_calc_permission: "laundry_greenleaf",
    laundry_calc_done: "laundry_calc",
    dish_brand: "dish_question",
    dish_permission: "dish_reaction_unknown",
    dish_video_permission: "dish_explanation",
    dish_calc_permission: "dish_greenleaf",
    dish_calc_done: "dish_calc",
    pads_intro: "pads_intro",
    pads_permission: "pads_reaction",
    pads_video_permission: "pads_explanation",
    pads_calc_permission: "pads_greenleaf",
    pads_calc_done: "pads_calc",
    toilet_brand: "toilet_question",
    toilet_permission: "toilet_reaction",
    toilet_video_permission: "toilet_explanation",
    toilet_calc_permission: "toilet_greenleaf",
    toilet_calc_done: "toilet_calc",
    family_question: "family_question",
    family_summary: "family_conclusion",
    company_permission: "family_conclusion",
    purchase_interest: "company_block",
    purchase_options_permission: "purchase_options",
    start_reaction: "start_offer",
    price_objection: "price_objection",
    model_permission: "bonus_block",
    model_reason_permission: "model_intro",
    final_summary_permission: "model_reason_result",
    final_interest: "final_logic",
    lead_name: "lead_name",
    lead_contact: "lead_contact",
    completed: "lead_done",
    doubt: "doubt",
  };

  const key = keyByStage[stage];
  if (key) {
    const values = key === "laundry_question_named" ? { name: session.firstName || "" } : {};
    await sendBotText(bot, chatId, session.id, stage, await getV2Text(key, values));
    return;
  }

  await bot.sendMessage(chatId, "Продолжаем с сохранённого этапа. Напиши «дальше».");
}

async function showMainMenu(bot: TelegramBot, chatId: number, session: BotSession, userId: number): Promise<void> {
  const partner = await getActivePartner(userId, session);
  const rows: InlineKeyboardButton[][] = [];

  if (session.isCompleted) rows.push([{ text: "📊 Расчёт экономии", callback_data: "menu_calc" }]);
  else rows.push([{ text: "▶️ Продолжить", callback_data: "menu_continue" }]);

  rows.push([
    { text: "📋 Моя заявка", callback_data: "menu_my_lead" },
    { text: "❓ Задать вопрос", callback_data: "menu_question" },
  ]);
  rows.push([{ text: "📞 Связаться", callback_data: "menu_contact" }]);

  if (partner) {
    rows.push([
      { text: "🔗 Моя ссылка", callback_data: "partner_link" },
      { text: "📋 Мои заявки", callback_data: "partner_leads" },
    ]);
    rows.push([
      { text: "📊 Моя статистика", callback_data: "partner_stats" },
      { text: "📤 Как отправить", callback_data: "partner_how" },
    ]);
  }

  if (await isAdmin(userId)) rows.push([{ text: "⚙️ Админ-панель", callback_data: "admin_menu" }]);
  rows.push([{ text: "🔄 Начать заново", callback_data: "restart_confirm" }]);

  await bot.sendMessage(chatId, `🏠 Главное меню\n\nТекущий этап: ${normalizeStoredStage(session.currentStage)}`, {
    reply_markup: { inline_keyboard: rows },
  });
}

async function handleGlobalIntent(
  bot: TelegramBot,
  chatId: number,
  session: BotSession,
  stage: V2Stage,
  text: string,
  intent: Intent,
): Promise<boolean> {
  if (isEarningsQuestion(text)) {
    await saveMessage(session.id, "user", text, stage, "earnings_question");
    await sendBotText(bot, chatId, session.id, stage, await getV2Text("earnings_answer"));
    return true;
  }

  if (intent === "objection_pyramid") {
    await saveMessage(session.id, "user", text, stage, intent);
    await sendBotText(bot, chatId, session.id, stage, await getV2Text("pyramid_objection"));
    return true;
  }

  if (
    intent === "wants_registration" &&
    !["final_interest", "lead_name", "lead_contact", "completed"].includes(stage)
  ) {
    await saveMessage(session.id, "user", text, stage, intent);
    await sendBotText(bot, chatId, session.id, stage, await getV2Text("early_registration"));
    return true;
  }

  if (
    intent === "objection_price" &&
    !["start_reaction", "price_objection", "final_interest"].includes(stage)
  ) {
    await saveMessage(session.id, "user", text, stage, intent);
    await sendBotText(bot, chatId, session.id, stage, await getV2Text("price_objection"));
    return true;
  }

  if (intent === "question") {
    await answerUserQuestion(bot, chatId, session, stage, text);
    return true;
  }

  if (isAccidentalShortInput(text)) {
    await saveMessage(session.id, "user", text, stage, "accidental");
    const response = await getV2Text("accidental_input", { topic: topicForStage(stage) });
    await sendBotText(bot, chatId, session.id, stage, response);
    return true;
  }

  return false;
}

export async function handleMessage(bot: TelegramBot, msg: Message): Promise<void> {
  const userId = msg.from?.id;
  const text = msg.text?.trim();
  if (!userId || !text) return;

  const chatId = msg.chat.id;
  const username = msg.from?.username;
  const firstName = msg.from?.first_name;
  const lastName = msg.from?.last_name;

  const replyAction = REPLY_ACTIONS[text];
  if (replyAction) {
    const fakeQuery: CallbackQuery = {
      id: `reply_${Date.now()}`,
      from: msg.from!,
      message: msg,
      chat_instance: String(chatId),
      data: replyAction,
    };
    await handleCallback(bot, fakeQuery);
    return;
  }

  if (text.startsWith("/start")) {
    const refCode = text.split(/\s+/)[1] || undefined;
    const session = await getOrCreateSession(userId, username, firstName, lastName, refCode);
    await sendIntro(bot, chatId, session);
    return;
  }

  if (text === "/id") {
    await bot.sendMessage(chatId, `Твой Telegram ID: ${userId}`);
    return;
  }

  const session = await getOrCreateSession(userId, username, firstName, lastName);

  if (text === "/menu") {
    await showMainMenu(bot, chatId, session, userId);
    return;
  }

  if (await isAdmin(userId)) {
    const state = (await db
      .select()
      .from(adminStateTable)
      .where(eq(adminStateTable.telegramUserId, userId))
      .limit(1))[0];
    if (state && state.mode !== "idle" && !["lead_name_stored", "lead_contact_stored"].includes(state.mode)) {
      await legacyHandleMessage(bot, msg);
      return;
    }
  }

  const questionReturnStage = parseQuestionStage(session.currentStage);
  if (questionReturnStage) {
    await answerUserQuestion(bot, chatId, session, questionReturnStage, text);
    await updateStage(session.id, questionReturnStage);
    return;
  }

  const stage = normalizeStoredStage(session.currentStage);
  if (stage !== session.currentStage) await updateStage(session.id, stage);

  const intent = classifyText(text);
  if (await handleGlobalIntent(bot, chatId, session, stage, text, intent)) return;

  switch (stage) {
    case "intro":
      await sendBotText(bot, chatId, session.id, stage, "Нажми кнопку «Начать» под приветствием — до этого момента я не буду запускать сценарий.");
      return;

    case "name_question": {
      await saveMessage(session.id, "user", text, stage);
      const name = isNameRefusal(text) ? null : extractFirstName(text);
      if (name) {
        await db.update(userSessionsTable).set({ firstName: name, updatedAt: new Date() }).where(eq(userSessionsTable.id, session.id));
        await sendBlock(bot, chatId, { ...session, firstName: name }, "laundry_brand", "laundry_question_named", { name });
      } else {
        await db.update(userSessionsTable).set({ firstName: null, updatedAt: new Date() }).where(eq(userSessionsTable.id, session.id));
        await sendBlock(bot, chatId, { ...session, firstName: null }, "laundry_brand", "laundry_question_anonymous");
      }
      return;
    }

    case "laundry_brand": {
      const classification = await classifyBrandAnswer(text, stage, session.id);
      await saveMessage(session.id, "user", text, stage, classification.intent);
      await sendBlock(bot, chatId, session, "laundry_permission", categoryReactionKey("laundry", classification.intent));
      return;
    }

    case "laundry_permission":
      await saveMessage(session.id, "user", text, stage, intent);
      if (isNegative(intent, text)) await sendBlock(bot, chatId, session, "laundry_calc_permission", "laundry_greenleaf");
      else await sendBlock(bot, chatId, session, "laundry_video_permission", "laundry_explanation");
      return;

    case "laundry_video_permission":
      await saveMessage(session.id, "user", text, stage, intent);
      if (wantsToSkip(text) || isNegative(intent, text)) {
        await sendBlock(bot, chatId, session, "laundry_calc_permission", "laundry_greenleaf");
      } else {
        const video = await composeVideoMessage("laundry_video", "После видео напиши, что бросилось в глаза: расход, состав, пена, выполаскивание или просто «понятно».");
        await updateStage(session.id, "laundry_video_reaction");
        await sendBotText(bot, chatId, session.id, "laundry_video_reaction", video);
      }
      return;

    case "laundry_video_reaction":
      await saveMessage(session.id, "user", text, stage, intent);
      await sendBlock(bot, chatId, session, "laundry_calc_permission", "laundry_greenleaf");
      return;

    case "laundry_calc_permission":
      await saveMessage(session.id, "user", text, stage, intent);
      if (isNegative(intent, text)) {
        await updateStage(session.id, "laundry_calc_done");
        await sendBotText(bot, chatId, session.id, "laundry_calc_done", "Ок, без расчёта по стирке. Пойдём к средству для посуды?");
      } else {
        await sendBlock(bot, chatId, session, "laundry_calc_done", "laundry_calc");
      }
      return;

    case "laundry_calc_done":
      await saveMessage(session.id, "user", text, stage, intent);
      if (isNegative(intent, text)) {
        await updateStage(session.id, "doubt");
        await sendBotText(bot, chatId, session.id, "doubt", await getV2Text("soft_decline"));
      } else await sendBlock(bot, chatId, session, "dish_brand", "dish_question");
      return;

    case "dish_brand": {
      const classification = await classifyBrandAnswer(text, stage, session.id);
      await saveMessage(session.id, "user", text, stage, classification.intent);
      await sendBlock(bot, chatId, session, "dish_permission", categoryReactionKey("dish", classification.intent));
      return;
    }

    case "dish_permission":
      await saveMessage(session.id, "user", text, stage, intent);
      if (isNegative(intent, text)) await sendBlock(bot, chatId, session, "dish_calc_permission", "dish_greenleaf");
      else await sendBlock(bot, chatId, session, "dish_video_permission", "dish_explanation");
      return;

    case "dish_video_permission":
      await saveMessage(session.id, "user", text, stage, intent);
      if (wantsToSkip(text) || isNegative(intent, text)) {
        await sendBlock(bot, chatId, session, "dish_calc_permission", "dish_greenleaf");
      } else {
        const video = await composeVideoMessage("dish_video", "После видео напиши, что заметил: расход, пена, смываемость или просто «норм, понятно».");
        await updateStage(session.id, "dish_video_reaction");
        await sendBotText(bot, chatId, session.id, "dish_video_reaction", video);
      }
      return;

    case "dish_video_reaction":
      await saveMessage(session.id, "user", text, stage, intent);
      await sendBlock(bot, chatId, session, "dish_calc_permission", "dish_greenleaf");
      return;

    case "dish_calc_permission":
      await saveMessage(session.id, "user", text, stage, intent);
      if (isNegative(intent, text)) {
        await updateStage(session.id, "dish_calc_done");
        await sendBotText(bot, chatId, session.id, "dish_calc_done", "Ок, без расчёта по посуде. Идём к следующей категории?");
      } else await sendBlock(bot, chatId, session, "dish_calc_done", "dish_calc");
      return;

    case "dish_calc_done":
      await saveMessage(session.id, "user", text, stage, intent);
      if (isNegative(intent, text)) {
        await updateStage(session.id, "doubt");
        await sendBotText(bot, chatId, session.id, "doubt", await getV2Text("soft_decline"));
      } else await sendBlock(bot, chatId, session, "pads_intro", "pads_intro");
      return;

    case "pads_intro":
      await saveMessage(session.id, "user", text, stage, intent);
      await sendBlock(bot, chatId, session, "pads_permission", "pads_reaction");
      return;

    case "pads_permission":
      await saveMessage(session.id, "user", text, stage, intent);
      if (isNegative(intent, text)) await sendBlock(bot, chatId, session, "pads_calc_permission", "pads_greenleaf");
      else await sendBlock(bot, chatId, session, "pads_video_permission", "pads_explanation");
      return;

    case "pads_video_permission":
      await saveMessage(session.id, "user", text, stage, intent);
      if (wantsToSkip(text) || isNegative(intent, text)) {
        await sendBlock(bot, chatId, session, "pads_calc_permission", "pads_greenleaf");
      } else {
        const video = await composeVideoMessage("pads_video", "После видео напиши, что показалось самым важным: комфорт, материалы, впитывание, воздухопроницаемость или просто «понятно».");
        await updateStage(session.id, "pads_video_reaction");
        await sendBotText(bot, chatId, session.id, "pads_video_reaction", video);
      }
      return;

    case "pads_video_reaction":
      await saveMessage(session.id, "user", text, stage, intent);
      await sendBlock(bot, chatId, session, "pads_calc_permission", "pads_greenleaf");
      return;

    case "pads_calc_permission":
      await saveMessage(session.id, "user", text, stage, intent);
      if (isNegative(intent, text)) {
        await updateStage(session.id, "pads_calc_done");
        await sendBotText(bot, chatId, session.id, "pads_calc_done", "Ок, без расчёта этой категории. Переходим к туалетной бумаге?");
      } else await sendBlock(bot, chatId, session, "pads_calc_done", "pads_calc");
      return;

    case "pads_calc_done":
      await saveMessage(session.id, "user", text, stage, intent);
      if (isNegative(intent, text)) {
        await updateStage(session.id, "doubt");
        await sendBotText(bot, chatId, session.id, "doubt", await getV2Text("soft_decline"));
      } else await sendBlock(bot, chatId, session, "toilet_brand", "toilet_question");
      return;

    case "toilet_brand":
      await saveMessage(session.id, "user", text, stage, intent);
      await sendBlock(bot, chatId, session, "toilet_permission", "toilet_reaction");
      return;

    case "toilet_permission":
      await saveMessage(session.id, "user", text, stage, intent);
      if (isNegative(intent, text)) await sendBlock(bot, chatId, session, "toilet_calc_permission", "toilet_greenleaf");
      else await sendBlock(bot, chatId, session, "toilet_video_permission", "toilet_explanation");
      return;

    case "toilet_video_permission":
      await saveMessage(session.id, "user", text, stage, intent);
      if (wantsToSkip(text) || isNegative(intent, text)) {
        await sendBlock(bot, chatId, session, "toilet_calc_permission", "toilet_greenleaf");
      } else {
        const video = await composeVideoMessage("toilet_video", "После видео напиши, что заметил. Даже «не думал, что туалетную бумагу можно так разбирать» — нормальный ответ 😄");
        await updateStage(session.id, "toilet_video_reaction");
        await sendBotText(bot, chatId, session.id, "toilet_video_reaction", video);
      }
      return;

    case "toilet_video_reaction":
      await saveMessage(session.id, "user", text, stage, intent);
      await sendBlock(bot, chatId, session, "toilet_calc_permission", "toilet_greenleaf");
      return;

    case "toilet_calc_permission":
      await saveMessage(session.id, "user", text, stage, intent);
      if (isNegative(intent, text)) {
        await updateStage(session.id, "toilet_calc_done");
        await sendBotText(bot, chatId, session.id, "toilet_calc_done", "Ок, без отдельного расчёта. Посмотрим весь домашний магазин за год?");
      } else await sendBlock(bot, chatId, session, "toilet_calc_done", "toilet_calc");
      return;

    case "toilet_calc_done":
      await saveMessage(session.id, "user", text, stage, intent);
      if (isNegative(intent, text)) {
        await updateStage(session.id, "doubt");
        await sendBotText(bot, chatId, session.id, "doubt", await getV2Text("soft_decline"));
      } else await sendBlock(bot, chatId, session, "family_question", "family_question");
      return;

    case "family_question": {
      await saveMessage(session.id, "user", text, stage, intent);
      const profile = parseFamilyProfile(text);
      const [updated] = await db
        .update(userSessionsTable)
        .set({
          familyAdults: profile.adults,
          familyChildren: profile.children,
          femaleHygieneRelevant: profile.femaleHygieneRelevant,
          updatedAt: new Date(),
        })
        .where(eq(userSessionsTable.id, session.id))
        .returning();
      const current = updated || { ...session, familyAdults: profile.adults, familyChildren: profile.children, femaleHygieneRelevant: profile.femaleHygieneRelevant };
      const calculation = await calculateForSession(current);
      await sendBlock(bot, chatId, current, "family_summary", "family_summary", {
        family: calculation.familyLabel,
        mass: formatMoney(calculation.mass),
        green: formatMoney(calculation.green),
        saving: formatMoney(calculation.saving),
      });
      return;
    }

    case "family_summary":
      await saveMessage(session.id, "user", text, stage, intent);
      if (isAffirmative(intent, text)) await sendSavingsTable(bot, chatId, session);
      await sendBlock(bot, chatId, session, "company_permission", "family_conclusion");
      return;

    case "company_permission": {
      await saveMessage(session.id, "user", text, stage, intent);
      const company = await getV2Text("company_block");
      const url = isNegative(intent, text) ? null : await getVideoUrl("company_video");
      const prefix = url ? `🎬 ${url}\n\n` : "";
      await updateStage(session.id, "purchase_interest");
      await sendBotText(bot, chatId, session.id, "purchase_interest", `${prefix}${company}`);
      return;
    }

    case "purchase_interest":
      await saveMessage(session.id, "user", text, stage, intent);
      if (isNegative(intent, text)) await sendBlock(bot, chatId, session, "doubt", "doubt");
      else await sendBlock(bot, chatId, session, "purchase_options_permission", "purchase_options");
      return;

    case "purchase_options_permission":
      await saveMessage(session.id, "user", text, stage, intent);
      if (isNegative(intent, text)) await sendBlock(bot, chatId, session, "doubt", "doubt");
      else await sendBlock(bot, chatId, session, "start_reaction", "start_offer");
      return;

    case "start_reaction":
      await saveMessage(session.id, "user", text, stage, intent);
      if (intent === "objection_price" || intent === "negative") {
        await sendBlock(bot, chatId, session, "price_objection", "price_objection");
      } else {
        const bonus = await getV2Text("bonus_block");
        const url = await getVideoUrl("bonus_video");
        await updateStage(session.id, "model_permission");
        await sendBotText(bot, chatId, session.id, "model_permission", `${url ? `🎬 ${url}\n\n` : ""}${bonus}`);
      }
      return;

    case "price_objection":
      await saveMessage(session.id, "user", text, stage, intent);
      if (isNegative(intent, text)) await sendBlock(bot, chatId, session, "doubt", "doubt");
      else {
        const bonus = await getV2Text("bonus_block");
        const url = await getVideoUrl("bonus_video");
        await updateStage(session.id, "model_permission");
        await sendBotText(bot, chatId, session.id, "model_permission", `${url ? `🎬 ${url}\n\n` : ""}${bonus}`);
      }
      return;

    case "model_permission":
      await saveMessage(session.id, "user", text, stage, intent);
      if (isNegative(intent, text)) await sendBlock(bot, chatId, session, "doubt", "doubt");
      else await sendBlock(bot, chatId, session, "model_reason_permission", "model_intro");
      return;

    case "model_reason_permission":
      await saveMessage(session.id, "user", text, stage, intent);
      if (isNegative(intent, text)) await sendBlock(bot, chatId, session, "doubt", "doubt");
      else await sendBlock(bot, chatId, session, "final_summary_permission", "model_reason_result");
      return;

    case "final_summary_permission":
      await saveMessage(session.id, "user", text, stage, intent);
      if (isNegative(intent, text)) await sendBlock(bot, chatId, session, "doubt", "doubt");
      else await sendBlock(bot, chatId, session, "final_interest", "final_logic");
      return;

    case "final_interest":
      await saveMessage(session.id, "user", text, stage, intent);
      if (intent === "objection_price") {
        await sendBlock(bot, chatId, session, "price_objection", "price_objection");
      } else if (isAffirmative(intent, text) || intent === "wants_registration") {
        if (session.leadId || session.isCompleted) {
          await updateStage(session.id, "completed");
          await sendBotText(bot, chatId, session.id, "completed", await getV2Text("lead_done"));
        } else if (session.firstName) {
          await sendBlock(bot, chatId, session, "lead_contact", "lead_contact");
        } else {
          await sendBlock(bot, chatId, session, "lead_name", "lead_name");
        }
      } else if (isNegative(intent, text)) {
        await sendBlock(bot, chatId, session, "doubt", "doubt");
      } else {
        await sendBotText(bot, chatId, session.id, stage, "Напиши «да», если хочешь открыть условия, или «пока подумаю».");
      }
      return;

    case "lead_name": {
      await saveMessage(session.id, "user", text, stage);
      const name = extractFirstName(text);
      if (!name) {
        await sendBotText(bot, chatId, session.id, stage, "Напиши, пожалуйста, только имя.");
        return;
      }
      await db.update(userSessionsTable).set({ firstName: name, updatedAt: new Date() }).where(eq(userSessionsTable.id, session.id));
      await sendBlock(bot, chatId, { ...session, firstName: name }, "lead_contact", "lead_contact");
      return;
    }

    case "lead_contact": {
      await saveMessage(session.id, "user", text, stage);
      if (!isValidContact(text)) {
        await sendBotText(bot, chatId, session.id, stage, await getV2Text("lead_contact_invalid"));
        return;
      }
      const contact = normalizeContact(text);
      await createLead(bot, { ...session, currentStage: stage }, contact);
      await sendBotText(bot, chatId, session.id, "completed", await getV2Text("lead_done"), { reply_markup: getReplyKeyboard() });
      return;
    }

    case "completed":
      await showMainMenu(bot, chatId, session, userId);
      return;

    case "doubt":
      await sendBotText(bot, chatId, session.id, stage, await getV2Text("doubt"));
      return;
  }
}

export async function handleCallback(bot: TelegramBot, query: CallbackQuery): Promise<void> {
  const chatId = query.message?.chat.id;
  if (!chatId) return;
  const data = query.data || "";

  if (!V2_CALLBACKS.has(data)) {
    await legacyHandleCallback(bot, query);
    return;
  }

  if (!query.id.startsWith("reply_")) {
    try {
      await bot.answerCallbackQuery(query.id);
    } catch (err) {
      logger.warn({ err, callbackId: query.id }, "Failed to answer v2 callback query");
    }
  }

  const session = await getOrCreateSession(
    query.from.id,
    query.from.username,
    query.from.first_name,
    query.from.last_name,
  );

  if (data === "v2_start") {
    await sendBlock(bot, chatId, session, "name_question", "name_question", {}, { reply_markup: getReplyKeyboard() });
    return;
  }

  if (data === "menu_main") {
    await showMainMenu(bot, chatId, session, query.from.id);
    return;
  }

  if (data === "menu_continue") {
    await sendCurrentPrompt(bot, chatId, session);
    return;
  }

  if (data === "menu_calc") {
    await sendSavingsTable(bot, chatId, session);
    return;
  }

  if (data === "menu_question") {
    const returnStage = normalizeStoredStage(session.currentStage);
    await updateStage(session.id, makeQuestionStage(returnStage));
    await bot.sendMessage(chatId, "Задай свой вопрос. Я отвечу коротко и верну тебя к текущему этапу.");
    return;
  }

  if (data === "menu_my_lead") {
    if (!session.leadId) {
      await bot.sendMessage(chatId, await getV2Text("no_lead"));
      return;
    }
    const lead = (await db.select().from(leadsTable).where(eq(leadsTable.id, session.leadId)).limit(1))[0];
    await bot.sendMessage(chatId, `📋 Твоя заявка\n\nСтатус: ${lead?.status || "—"}\nДата: ${lead?.createdAt.toLocaleString("ru-RU") || "—"}`);
    return;
  }

  if (data === "menu_contact") {
    let contact = await getSetting("default_contact");
    if (session.partnerId) {
      const partner = (await db.select().from(partnersTable).where(eq(partnersTable.id, session.partnerId)).limit(1))[0];
      contact = partner?.telegram || partner?.phone || contact;
    }
    await bot.sendMessage(chatId, `📞 Связаться: ${contact || "контакт пока не указан"}`);
    return;
  }

  if (data === "restart_confirm") {
    await db
      .update(userSessionsTable)
      .set({
        currentStage: "intro",
        depthMode: null,
        familyAdults: null,
        familyChildren: null,
        femaleHygieneRelevant: null,
        menuShown: false,
        updatedAt: new Date(),
      })
      .where(eq(userSessionsTable.id, session.id));
    await sendIntro(bot, chatId, { ...session, currentStage: "intro" });
  }
}
