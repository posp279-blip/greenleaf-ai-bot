import TelegramBot from "node-telegram-bot-api";
import type { Message, CallbackQuery, InlineKeyboardButton } from "node-telegram-bot-api";
import { db } from "@workspace/db";
import {
  userSessionsTable,
  messagesTable,
  leadsTable,
  videoBlocksTable,
  appSettingsTable,
  partnersTable,
  adminStateTable,
  calculatorItemsTable,
} from "@workspace/db";
import { eq, desc, and } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import { classifyText, detectBrandName } from "./classifier.js";
import { classifyUserInput, generateReaction, answerQuestion, isAiAvailable } from "./ai.js";
import {
  getLaundryReaction, getDishReaction, getPadsReaction,
  getToiletReaction, getObjectionPriceResponse,
  getObjectionPyramidResponse, getEarlyRegistrationResponse,
} from "./reactions.js";
import { TEXTS } from "./texts.js";

type BotSession = typeof userSessionsTable.$inferSelect;

async function getSetting(key: string): Promise<string> {
  const rows = await db.select().from(appSettingsTable).where(eq(appSettingsTable.key, key));
  return rows[0]?.value ?? "";
}

async function getAdminIds(): Promise<number[]> {
  const raw = await getSetting("admin_telegram_ids");
  const envRaw = process.env.ADMIN_TELEGRAM_IDS;
  const combined = [raw, envRaw].filter(Boolean).join(",");
  if (!combined) return [];
  return combined.split(",").map((s) => parseInt(s.trim(), 10)).filter(Boolean);
}

async function isAdmin(userId: number): Promise<boolean> {
  const ids = await getAdminIds();
  return ids.includes(userId);
}

async function getActivePartner(userId: number) {
  const rows = await db.select().from(partnersTable).where(
    and(eq(partnersTable.telegramUserId, userId), eq(partnersTable.isActive, true))
  );
  if (rows[0]) return rows[0];
  const sessions = await db.select().from(userSessionsTable).where(
    eq(userSessionsTable.telegramUserId, userId)
  );
  if (sessions[0]?.partnerId) {
    const p = await db.select().from(partnersTable).where(
      and(eq(partnersTable.id, sessions[0].partnerId), eq(partnersTable.isActive, true))
    );
    if (p[0]) return p[0];
  }
  return null;
}

// Reply Keyboard — single "☰ Меню" button at bottom, opens inline menu on tap
function getReplyKeyboard() {
  return { keyboard: [[{ text: "☰ Меню" }]], resize_keyboard: true };
}

// Reply keyboard text → callback action
const REPLY_ACTIONS: Record<string, string> = {
  "☰ Меню": "menu_main",
};

function escapeMarkdown(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, "\\$1");
}

async function notifyPartner(bot: TelegramBot, partnerId: number, text: string) {
  const p = await db.select().from(partnersTable).where(eq(partnersTable.id, partnerId));
  if (!p[0]?.telegramUserId) return;
  try {
    await bot.sendMessage(p[0].telegramUserId, text, { parse_mode: "MarkdownV2" });
  } catch (err) {
    logger.error({ err, partnerId }, "Partner notify failed");
  }
}

async function getOrCreateSession(
  userId: number, username: string | undefined,
  firstName: string | undefined, lastName: string | undefined,
  refCode?: string
): Promise<BotSession> {
  const existing = await db.select().from(userSessionsTable)
    .where(eq(userSessionsTable.telegramUserId, userId));

  if (existing[0]) {
    await db.update(userSessionsTable)
      .set({ username: username || existing[0].username, firstName: firstName || existing[0].firstName, updatedAt: new Date() })
      .where(eq(userSessionsTable.id, existing[0].id));
    // Re-read to get the latest partnerId/refCode if they were updated externally
    const fresh = await db.select().from(userSessionsTable).where(eq(userSessionsTable.id, existing[0].id));
    return fresh[0] || existing[0];
  }

  let partnerId: number | null = null;
  if (refCode) {
    const partners = await db.select().from(partnersTable)
      .where(and(eq(partnersTable.refCode, refCode), eq(partnersTable.isActive, true)));
    if (partners[0]) partnerId = partners[0].id;
  }

  const [session] = await db.insert(userSessionsTable).values({
    telegramUserId: userId,
    username,
    firstName,
    lastName,
    refCode,
    partnerId,
    currentStage: "intro",
  }).returning();
  return session;
}

async function updateStage(sessionId: number, stage: string) {
  await db.update(userSessionsTable)
    .set({ currentStage: stage, updatedAt: new Date() })
    .where(eq(userSessionsTable.id, sessionId));
}

async function saveMessage(sessionId: number, role: "user" | "bot", content: string, stage: string, intent?: string) {
  await db.insert(messagesTable).values({ sessionId, role, content, stage, intent });
}

async function getVideoUrl(key: string): Promise<string | null> {
  const rows = await db.select().from(videoBlocksTable)
    .where(and(eq(videoBlocksTable.key, key), eq(videoBlocksTable.isActive, true)));
  return rows[0]?.url || null;
}

async function sendVideo(bot: TelegramBot, chatId: number, key: string) {
  const url = await getVideoUrl(key);
  if (url) {
    await bot.sendMessage(chatId, `🎬 ${url}`);
  } else {
    await bot.sendMessage(chatId, TEXTS.videoPlaceholder, {
      reply_markup: { inline_keyboard: [[{ text: "Продолжить", callback_data: `continue_after_video_${key}` }]] }
    });
  }
}

async function sendCalcTable(bot: TelegramBot, chatId: number) {
  const items = await db.select().from(calculatorItemsTable).orderBy(calculatorItemsTable.order);
  let table = "📊 *Таблица расчёта по 13 категориям:*\n\n";
  let totalMass = 0, totalGreen = 0, totalSaving = 0;
  for (const item of items) {
    if (!item.isActive) continue;
    totalMass += item.massMarketYearPrice;
    totalGreen += item.greenleafYearPrice;
    totalSaving += item.savingYear;
    table += `*${item.category}*: ${item.massMarketYearPrice.toLocaleString("ru")} / ${item.greenleafYearPrice.toLocaleString("ru")} / ${item.savingYear.toLocaleString("ru")} ₽\n`;
  }
  table += `\n*ИТОГО:* ${totalMass.toLocaleString("ru")} / ${totalGreen.toLocaleString("ru")} / ${totalSaving.toLocaleString("ru")} ₽\n`;
  table += `\n_Расчёт примерный._`;
  await bot.sendMessage(chatId, table, {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: [[{ text: "← Назад", callback_data: "back_to_conclusion" }]] }
  });
}

async function notifyAdmins(bot: TelegramBot, text: string) {
  const notifEnabled = await getSetting("telegram_notifications_enabled");
  if (notifEnabled !== "true") return;
  const adminIds = await getAdminIds();
  for (const adminId of adminIds) {
    try { await bot.sendMessage(adminId, text, { parse_mode: "MarkdownV2" }); } catch (err) { logger.error({ err, adminId }, "Admin notify failed"); }
  }
}

// ─── Stage handlers ────────────────────────────────────────────────────────────

async function handleIntro(bot: TelegramBot, chatId: number, session: BotSession) {
  await updateStage(session.id, "intro_video");
  await bot.sendMessage(chatId, TEXTS.intro, { parse_mode: "Markdown", reply_markup: getReplyKeyboard() });
  await sendVideo(bot, chatId, "intro_video");
  await bot.sendMessage(chatId, "Готов начать разбор?", {
    reply_markup: { inline_keyboard: [[{ text: "▶️ Начать", callback_data: "start_depth_choice" }]] }
  });
  await saveMessage(session.id, "bot", TEXTS.intro, "intro");
}

async function handleDepthChoice(bot: TelegramBot, chatId: number, session: BotSession) {
  await updateStage(session.id, "depth_choice");
  await db.update(userSessionsTable).set({ menuShown: true, updatedAt: new Date() }).where(eq(userSessionsTable.id, session.id));
  await bot.sendMessage(chatId, TEXTS.depthChoice, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "⚡ Быстро по сути", callback_data: "depth_quick" }],
        [{ text: "🔍 Подробно", callback_data: "depth_detailed" }],
        [{ text: "💰 Сначала хочу увидеть экономию", callback_data: "depth_savings" }],
        [{ text: "🏠 Главное меню", callback_data: "menu_main" }],
      ]
    }
  });
  await saveMessage(session.id, "bot", TEXTS.depthChoice, "depth_choice");
}

async function handleLaundryQuestion(bot: TelegramBot, chatId: number, session: BotSession) {
  await updateStage(session.id, "laundry_question");
  await bot.sendMessage(chatId, TEXTS.laundryQuestion, { parse_mode: "Markdown" });
  await saveMessage(session.id, "bot", TEXTS.laundryQuestion, "laundry_question");
}

async function handleDishQuestion(bot: TelegramBot, chatId: number, session: BotSession) {
  await updateStage(session.id, "dish_question");
  await bot.sendMessage(chatId, TEXTS.dishQuestion, { parse_mode: "Markdown" });
  await saveMessage(session.id, "bot", TEXTS.dishQuestion, "dish_question");
}

async function handlePadsIntro(bot: TelegramBot, chatId: number, session: BotSession) {
  await updateStage(session.id, "pads_intro");
  await bot.sendMessage(chatId, TEXTS.padsIntro, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [[{ text: "Да, задумывался", callback_data: "pads_yes" }, { text: "Нет", callback_data: "pads_no" }]]
    }
  });
  await saveMessage(session.id, "bot", TEXTS.padsIntro, "pads_intro");
}

async function handleToiletQuestion(bot: TelegramBot, chatId: number, session: BotSession) {
  await updateStage(session.id, "toilet_question");
  await bot.sendMessage(chatId, TEXTS.toiletQuestion, { parse_mode: "Markdown" });
  await saveMessage(session.id, "bot", TEXTS.toiletQuestion, "toilet_question");
}

async function handleFamilyQuestion(bot: TelegramBot, chatId: number, session: BotSession) {
  await updateStage(session.id, "family_question");
  await bot.sendMessage(chatId, TEXTS.familyQuestion, { parse_mode: "Markdown" });
  await saveMessage(session.id, "bot", TEXTS.familyQuestion, "family_question");
}

async function handleBigCalculation(bot: TelegramBot, chatId: number, session: BotSession) {
  await updateStage(session.id, "big_calculation");
  await bot.sendMessage(chatId, TEXTS.bigCalculation, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "📊 Показать таблицу по 13 категориям", callback_data: "show_table" }],
        [{ text: "Дальше →", callback_data: "calc_conclusion" }],
      ]
    }
  });
  await saveMessage(session.id, "bot", TEXTS.bigCalculation, "big_calculation");
}

async function handleFinalQuestion(bot: TelegramBot, chatId: number, session: BotSession) {
  await updateStage(session.id, "final_question");
  await bot.sendMessage(chatId, TEXTS.finalQuestion, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ Хочу открыть условия Greenleaf", callback_data: "lead_capture_start" }],
        [{ text: "🤔 Пока подумаю", callback_data: "final_doubt" }],
      ]
    }
  });
  await saveMessage(session.id, "bot", TEXTS.finalQuestion, "final_question");
}

async function handleLeadCapture(bot: TelegramBot, chatId: number, session: BotSession) {
  await updateStage(session.id, "lead_capture_name");
  await bot.sendMessage(chatId, TEXTS.leadCaptureName, { parse_mode: "Markdown" });
  await saveMessage(session.id, "bot", TEXTS.leadCaptureName, "lead_capture_name");
}

// ─── Main message handler ──────────────────────────────────────────────────────

export async function handleMessage(bot: TelegramBot, msg: Message) {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  if (!userId || !msg.text) return;

  const text = msg.text.trim();
  const username = msg.from?.username;
  const firstName = msg.from?.first_name;
  const lastName = msg.from?.last_name;

  // Reply keyboard buttons handling
  const replyAction = REPLY_ACTIONS[text];
  if (replyAction) {
    const fakeQuery: CallbackQuery = {
      id: "reply_" + Date.now(),
      from: msg.from!,
      message: msg,
      chat_instance: String(msg.chat.id),
      data: replyAction,
    };
    await handleCallback(bot, fakeQuery);
    return;
  }

  if (text.startsWith("/start")) {
    const parts = text.split(" ");
    const refCode = parts[1] || undefined;
    const existing = await db.select().from(userSessionsTable).where(eq(userSessionsTable.telegramUserId, userId));
    if (existing[0] && refCode && !existing[0].refCode) {
      let partnerId: number | null = null;
      const partners = await db.select().from(partnersTable).where(and(eq(partnersTable.refCode, refCode), eq(partnersTable.isActive, true)));
      if (partners[0]) partnerId = partners[0].id;
      await db.update(userSessionsTable).set({ refCode, partnerId, updatedAt: new Date() }).where(eq(userSessionsTable.id, existing[0].id));
      // Update the in-memory object so the rest of the flow sees the partnerId
      existing[0].refCode = refCode;
      existing[0].partnerId = partnerId;
    }
    const session = await getOrCreateSession(userId, username, firstName, lastName, refCode);
    await handleIntro(bot, chatId, session);
    return;
  }

  if (text === "/menu") {
    const session = await getOrCreateSession(userId, username, firstName, lastName);
    await showMainMenu(bot, chatId, session, await isAdmin(userId), await getActivePartner(userId));
    return;
  }

  if (text === "/id") {
    await bot.sendMessage(chatId, `Твой Telegram ID: \`${userId}\`\n\nСообщи это число администратору, если тебе нужно привязать аккаунт.`, { parse_mode: "Markdown" });
    return;
  }

  const session = await getOrCreateSession(userId, username, firstName, lastName);
  const adminFlag = await isAdmin(userId);

  // Check admin state first
  if (adminFlag) {
    const adminStateRows = await db.select().from(adminStateTable).where(eq(adminStateTable.telegramUserId, userId));
    const adminState = adminStateRows[0];
    if (adminState && adminState.mode !== "idle") {
      await handleAdminInput(bot, chatId, userId, session, text, adminState);
      return;
    }
  }

  // Check user lead-capture state
  const leadStateRows = await db.select().from(adminStateTable).where(eq(adminStateTable.telegramUserId, userId));
  const userState = leadStateRows[0];
  if (userState && (userState.mode === "lead_name_stored" || userState.mode === "lead_contact_stored")) {
    await handleLeadInput(bot, chatId, userId, session, text, userState);
    return;
  }

  const stage = session.currentStage;
  const quickIntent = classifyText(text);

  // Global objection handlers
  if (quickIntent === "objection_pyramid") {
    await saveMessage(session.id, "user", text, stage, quickIntent);
    await bot.sendMessage(chatId, getObjectionPyramidResponse(), {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[{ text: "Продолжить разбор", callback_data: "menu_continue" }]] }
    });
    return;
  }
  if (quickIntent === "objection_price") {
    await saveMessage(session.id, "user", text, stage, quickIntent);
    await bot.sendMessage(chatId, getObjectionPriceResponse(), {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[{ text: "Продолжить разбор", callback_data: "menu_continue" }]] }
    });
    return;
  }
  if (quickIntent === "wants_registration" && !["final_question", "lead_capture_name", "lead_capture_contact", "lead_capture_comment", "completed"].includes(stage)) {
    await saveMessage(session.id, "user", text, stage, quickIntent);
    await bot.sendMessage(chatId, getEarlyRegistrationResponse(), {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[{ text: "Продолжить разбор", callback_data: "menu_continue" }]] }
    });
    return;
  }

  // Stage-specific text handling
  switch (stage) {
    case "laundry_question": {
      let intent: string = classifyText(text);
      const brandName = detectBrandName(text) || undefined;
      try { const ai = await classifyUserInput(text, stage, session.id); if (ai.intent !== "other") intent = ai.intent; } catch {}
      await saveMessage(session.id, "user", text, stage, intent);
      let reaction: string | null = null;
      try { reaction = await generateReaction(text, intent, stage, brandName, session.id); } catch {}
      if (!reaction) reaction = getLaundryReaction(intent, brandName);
      await updateStage(session.id, "laundry_reaction");
      await bot.sendMessage(chatId, reaction, { parse_mode: "Markdown" });
      await bot.sendMessage(chatId, TEXTS.laundryShortComposition, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[{ text: "Коротко", callback_data: "laundry_short" }, { text: "Подробнее", callback_data: "laundry_detailed" }], [{ text: "К видео", callback_data: "laundry_video" }]] }
      });
      await saveMessage(session.id, "bot", reaction, "laundry_reaction", intent);
      break;
    }
    case "dish_question": {
      let intent: string = classifyText(text);
      const brandName = detectBrandName(text) || undefined;
      try { const ai = await classifyUserInput(text, stage, session.id); if (ai.intent !== "other") intent = ai.intent; } catch {}
      await saveMessage(session.id, "user", text, stage, intent);
      let reaction: string | null = null;
      try { reaction = await generateReaction(text, intent, stage, brandName, session.id); } catch {}
      if (!reaction) reaction = getDishReaction(intent, brandName);
      await updateStage(session.id, "dish_reaction");
      await bot.sendMessage(chatId, reaction, { parse_mode: "Markdown" });
      await bot.sendMessage(chatId, TEXTS.dishShortComposition, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[{ text: "Коротко", callback_data: "dish_short" }, { text: "Подробнее", callback_data: "dish_detailed" }], [{ text: "К видео", callback_data: "dish_video" }]] }
      });
      await saveMessage(session.id, "bot", reaction, "dish_reaction", intent);
      break;
    }
    case "toilet_question": {
      let intent: string = classifyText(text);
      const brandName = detectBrandName(text) || undefined;
      try { const ai = await classifyUserInput(text, stage, session.id); if (ai.intent !== "other") intent = ai.intent; } catch {}
      await saveMessage(session.id, "user", text, stage, intent);
      const reaction = getToiletReaction(intent, brandName);
      await updateStage(session.id, "toilet_reaction");
      await bot.sendMessage(chatId, reaction, { parse_mode: "Markdown" });
      await bot.sendMessage(chatId, TEXTS.toiletShortComposition, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[{ text: "Коротко", callback_data: "toilet_short" }, { text: "Подробнее", callback_data: "toilet_detailed" }], [{ text: "К видео", callback_data: "toilet_video" }]] }
      });
      await saveMessage(session.id, "bot", reaction, "toilet_reaction", intent);
      break;
    }
    case "family_question": {
      await saveMessage(session.id, "user", text, stage);
      const numMatch = text.match(/\d+/);
      const count = numMatch ? parseInt(numMatch[0], 10) : 1;
      await db.update(userSessionsTable).set({ familyAdults: count, updatedAt: new Date() }).where(eq(userSessionsTable.id, session.id));
      await handleBigCalculation(bot, chatId, session);
      break;
    }
    case "lead_capture_name": {
      await saveMessage(session.id, "user", text, stage);
      await db.update(userSessionsTable).set({ currentStage: "lead_capture_contact", updatedAt: new Date() }).where(eq(userSessionsTable.id, session.id));
      await db.insert(adminStateTable).values({
        telegramUserId: userId, mode: "lead_name_stored", pendingAction: "lead_capture", payload: { name: text } as Record<string, unknown>,
      }).onConflictDoUpdate({ target: adminStateTable.telegramUserId, set: { mode: "lead_name_stored", pendingAction: "lead_capture", payload: { name: text } as Record<string, unknown>, updatedAt: new Date() } });
      await bot.sendMessage(chatId, TEXTS.leadCaptureContact);
      await saveMessage(session.id, "bot", TEXTS.leadCaptureContact, "lead_capture_contact");
      break;
    }
    default: {
      await saveMessage(session.id, "user", text, stage, quickIntent);
      if (quickIntent === "question" || quickIntent === "other") {
        let aiAnswer: string | null = null;
        try { aiAnswer = await answerQuestion(text, stage, session.id); } catch {}
        const response = aiAnswer || "Хороший вопрос. Давай продолжим разбор.";
        await bot.sendMessage(chatId, response, {
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: [[{ text: "Продолжить", callback_data: "menu_continue" }]] }
        });
      } else {
        await bot.sendMessage(chatId, "Хорошо, продолжаем.", {
          reply_markup: { inline_keyboard: [[{ text: "Продолжить", callback_data: "menu_continue" }]] }
        });
      }
    }
  }
}

async function handleLeadInput(bot: TelegramBot, chatId: number, userId: number, session: BotSession, text: string, state: typeof adminStateTable.$inferSelect) {
  const payload = (state.payload as Record<string, unknown>) || {};

  if (state.mode === "lead_name_stored") {
    await db.update(userSessionsTable).set({ currentStage: "lead_capture_comment", updatedAt: new Date() }).where(eq(userSessionsTable.id, session.id));
    await db.update(adminStateTable).set({ mode: "lead_contact_stored", payload: { ...payload, contact: text } as Record<string, unknown>, updatedAt: new Date() }).where(eq(adminStateTable.telegramUserId, userId));
    await bot.sendMessage(chatId, TEXTS.leadCaptureComment);
    await saveMessage(session.id, "bot", TEXTS.leadCaptureComment, "lead_capture_comment");
    return;
  }

  if (state.mode === "lead_contact_stored") {
    const leadName = String(payload.name || session.firstName || "Пользователь");
    const leadContact = String(payload.contact || "");
    const leadComment = text === "—" || text === "-" ? "" : text;
    await saveMessage(session.id, "user", text, "lead_capture_comment");

    const [lead] = await db.insert(leadsTable).values({
      sessionId: session.id, partnerId: session.partnerId,
      name: leadName, contact: leadContact, comment: leadComment, status: "новая",
    }).returning();

    await db.update(userSessionsTable).set({
      currentStage: "completed", leadId: lead.id,
      isCompleted: true, completedAt: new Date(), updatedAt: new Date(),
    }).where(eq(userSessionsTable.id, session.id));

    await db.update(adminStateTable).set({ mode: "idle", pendingAction: null, payload: null, updatedAt: new Date() }).where(eq(adminStateTable.telegramUserId, userId));

    await bot.sendMessage(chatId, TEXTS.leadDone, {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[{ text: "🏠 Главное меню", callback_data: "menu_main" }], [{ text: "📋 Моя заявка", callback_data: "menu_my_lead" }], [{ text: "❓ Задать вопрос", callback_data: "menu_question" }]] }
    });
    await saveMessage(session.id, "bot", TEXTS.leadDone, "completed");

    let partnerInfo = "не указан";
    if (session.partnerId) {
      const pRows = await db.select().from(partnersTable).where(eq(partnersTable.id, session.partnerId));
      if (pRows[0]) partnerInfo = `${pRows[0].name} (${pRows[0].refCode})`;
    }
    const notifText = `🆕 Новая заявка\!

Имя: ${escapeMarkdown(leadName)}
Контакт: ${escapeMarkdown(leadContact)}
Комментарий: ${leadComment ? escapeMarkdown(leadComment) : "—"}
Партнёр: ${escapeMarkdown(partnerInfo)}
Дата: ${escapeMarkdown(new Date().toLocaleString("ru"))}`;
    await notifyAdmins(bot, notifText);

    // Also notify the partner who referred this lead
    if (session.partnerId) {
      await notifyPartner(bot, session.partnerId, `🆕 Новая заявка по твоей ссылке\!

Имя: ${escapeMarkdown(leadName)}
Контакт: ${escapeMarkdown(leadContact)}
Статус: новая
Дата: ${escapeMarkdown(new Date().toLocaleString("ru"))}`);
    }
  }
}

// ─── Callback query handler ────────────────────────────────────────────────────

export async function handleCallback(bot: TelegramBot, query: CallbackQuery) {
  const chatId = query.message?.chat.id;
  const userId = query.from.id;
  if (!chatId) return;

  const data = query.data || "";
  // Answer real callback queries (skip fake ones from reply keyboard)
  if (!query.id.startsWith("reply_")) {
    try {
      await bot.answerCallbackQuery(query.id);
    } catch {
      // Query expired or already answered — safe to ignore
    }
  }

  const session = await getOrCreateSession(userId, query.from.username, query.from.first_name, query.from.last_name);
  const adminFlag = await isAdmin(userId);
  const partner = await getActivePartner(userId);

  // ── Menu ──
  if (data === "menu_main") {
    await showMainMenu(bot, chatId, session, adminFlag, partner);
    return;
  }

  if (data === "restart_confirm") {
    await db.update(userSessionsTable).set({ currentStage: "intro", menuShown: false, updatedAt: new Date() }).where(eq(userSessionsTable.id, session.id));
    await handleIntro(bot, chatId, { ...session, currentStage: "intro" });
    return;
  }

  if (data === "menu_continue") {
    await continueFromStage(bot, chatId, session);
    return;
  }

  if (data === "menu_calc") {
    await bot.sendMessage(chatId, TEXTS.bigCalculation, {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[{ text: "📊 Показать таблицу", callback_data: "show_table" }], [{ text: "Продолжить разбор", callback_data: "menu_continue" }]] }
    });
    return;
  }

  if (data === "menu_question") {
    const prevStage = session.currentStage;
    await db.update(userSessionsTable).set({ currentStage: `question_mode_${prevStage}`, updatedAt: new Date() }).where(eq(userSessionsTable.id, session.id));
    await bot.sendMessage(chatId, "Задай свой вопрос — я отвечу и вернёмся к разбору.");
    return;
  }

  if (data === "menu_my_lead") {
    if (!session.leadId) {
      await bot.sendMessage(chatId, TEXTS.noLeadYet, {
        reply_markup: { inline_keyboard: [[{ text: "Продолжить", callback_data: "menu_continue" }], [{ text: "К расчёту", callback_data: "menu_calc" }]] }
      });
    } else {
      const leads = await db.select().from(leadsTable).where(eq(leadsTable.id, session.leadId));
      const lead = leads[0];
      await bot.sendMessage(chatId, `📋 *Твоя заявка*\n\nСтатус: *${lead?.status || "—"}*\nДата: ${lead?.createdAt.toLocaleString("ru") || "—"}`, { parse_mode: "Markdown" });
    }
    return;
  }

  if (data === "menu_contact") {
    let contact = await getSetting("default_contact");
    if (session.partnerId) {
      const pRows = await db.select().from(partnersTable).where(eq(partnersTable.id, session.partnerId));
      if (pRows[0]?.telegram) contact = pRows[0].telegram;
    }
    await bot.sendMessage(chatId, `📞 *Связаться:* ${contact}`, { parse_mode: "Markdown" });
    return;
  }

  // ── Partner menu ──
  if (data === "partner_link") {
    if (!partner) { await bot.sendMessage(chatId, TEXTS.noPartnerLink); return; }
    const botUsername = await getSetting("bot_username");
    if (!botUsername) { await bot.sendMessage(chatId, "⚠️ bot_username не задан в настройках."); return; }
    const link = `https://t.me/${botUsername}?start=${partner.refCode}`;
    await bot.sendMessage(chatId, `🔗 *Твоя ссылка:*\n\n\`${link}\``, { parse_mode: "Markdown" });
    return;
  }

  if (data === "partner_leads") {
    if (!partner) { await bot.sendMessage(chatId, TEXTS.noPartnerLink); return; }
    const leads = await db.select().from(leadsTable).where(eq(leadsTable.partnerId, partner.id));
    if (leads.length === 0) { await bot.sendMessage(chatId, "📋 Заявок по твоей ссылке пока нет."); return; }
    for (const l of leads) {
      const rows: InlineKeyboardButton[][] = [];
      let msg = `📋 *${escapeMarkdown(l.name)}*\nКонтакт: ${escapeMarkdown(l.contact)}\nСтатус: *${escapeMarkdown(l.status)}*\nДата: ${escapeMarkdown(l.createdAt.toLocaleDateString("ru"))}`;
      if (l.status === "новая") {
        rows.push([{ text: "✅ Регистрировать как партнёра", callback_data: `partner_register_${l.id}` }]);
      }
      rows.push([{ text: "← Назад", callback_data: "menu_main" }]);
      await bot.sendMessage(chatId, msg, { parse_mode: "MarkdownV2", reply_markup: { inline_keyboard: rows } });
    }
    return;
  }

  if (data.startsWith("partner_register_")) {
    if (!partner) { await bot.sendMessage(chatId, TEXTS.noPartnerLink); return; }
    const leadId = parseInt(data.replace("partner_register_", ""), 10);
    const lead = (await db.select().from(leadsTable).where(eq(leadsTable.id, leadId)))[0];
    if (!lead || lead.partnerId !== partner.id) { await bot.sendMessage(chatId, "⚠️ Заявка не найдена."); return; }
    if (lead.status !== "новая") { await bot.sendMessage(chatId, "⚠️ Заявка уже обработана."); return; }

    // Generate unique refCode
    const baseRef = (lead.name || "partner").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "user";
    let refCode = baseRef;
    let suffix = 1;
    while ((await db.select().from(partnersTable).where(eq(partnersTable.refCode, refCode))).length > 0) {
      refCode = `${baseRef}${suffix}`;
      suffix++;
    }

    const sessionRow = (await db.select().from(userSessionsTable).where(eq(userSessionsTable.id, lead.sessionId)))[0];
    const [newPartner] = await db.insert(partnersTable).values({
      name: lead.name,
      telegram: lead.contact.startsWith("@") ? lead.contact : null,
      phone: !lead.contact.startsWith("@") ? lead.contact : null,
      refCode,
      telegramUserId: sessionRow?.telegramUserId || null,
      sponsorPartnerId: partner.id,
      sourceLeadId: lead.id,
      isActive: true,
    }).returning();

    // Update user sessions
    if (sessionRow?.telegramUserId) {
      await db.update(userSessionsTable)
        .set({ partnerId: newPartner.id, updatedAt: new Date() })
        .where(eq(userSessionsTable.telegramUserId, sessionRow.telegramUserId));
    }

    await db.update(leadsTable).set({ convertedPartnerId: newPartner.id, status: "зарегистрирован", updatedAt: new Date() }).where(eq(leadsTable.id, leadId));

    // Notify the new partner
    const botUsername = await getSetting("bot_username");
    if (botUsername && sessionRow?.telegramUserId) {
      const link = `https://t.me/${botUsername}?start=${newPartner.refCode}`;
      try {
        await bot.sendMessage(
          sessionRow.telegramUserId,
          `🎉 Поздравляем\! Ты теперь партнёр Greenleaf\!\n\nТвоя реферальная ссылка:\n${escapeMarkdown(link)}\n\nОткрой меню бота и нажми "📞 Партнёрам" — там всё для работы с ссылкой\.`,
          {
            reply_markup: {
              keyboard: [[{ text: "☀ Меню" }]],
              resize_keyboard: true,
            },
          }
        );
      } catch (err) {
        // ignore if blocked
      }
    }

    await bot.sendMessage(chatId, `✅ ${escapeMarkdown(lead.name)} зарегистрирован как партнёр\!\nrefCode: \`${escapeMarkdown(refCode)}\``, { parse_mode: "MarkdownV2" });
    return;
  }

  if (data === "partner_how") {
    if (!partner) { await bot.sendMessage(chatId, TEXTS.noPartnerLink); return; }
    const botUsername = await getSetting("bot_username");
    const link = botUsername ? `https://t.me/${botUsername}?start=${partner.refCode}` : "[твоя ссылка]";
    await bot.sendMessage(chatId,
      `📤 Как отправить бот 3 людям:\n\nПример текста:\n«Привет. Я нашёл полезный бот, который показывает, сколько семья тратит на товары для дома за год. Без давления — просто разбор и расчёт. Посмотри: ${link}»\n\nКому отправить:\n• Семьи с бытовыми расходами\n• Те, кто ценит экономию\n• Те, кто интересуется безопасными средствами`
    );
    return;
  }

  if (data === "partner_stats") {
    if (!partner) { await bot.sendMessage(chatId, TEXTS.noPartnerLink); return; }
    const sessions = await db.select().from(userSessionsTable).where(eq(userSessionsTable.partnerId, partner.id));
    const leads = await db.select().from(leadsTable).where(eq(leadsTable.partnerId, partner.id));
    const registered = leads.filter((l) => l.status === "зарегистрирован").length;
    await bot.sendMessage(chatId,
      `📊 *Статистика:*\n\nПереходов: ${sessions.length}\nЗаявок: ${leads.length}\nЗарегистрированы: ${registered}\nКонверсия: ${sessions.length ? Math.round((leads.length / sessions.length) * 100) : 0}%`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  // ── Admin ──
  if (data === "admin_menu" && adminFlag) { await showAdminMenu(bot, chatId); return; }

  // ── Scenario ──
  if (data === "start_depth_choice") { await handleDepthChoice(bot, chatId, session); return; }

  if (data === "depth_quick") {
    await db.update(userSessionsTable).set({ depthMode: "quick", updatedAt: new Date() }).where(eq(userSessionsTable.id, session.id));
    await bot.sendMessage(chatId, "Отлично. По каждой категории — только главное: что стоит проверить, почему важно, и чем отличается Greenleaf.");
    await handleLaundryQuestion(bot, chatId, session);
    return;
  }

  if (data === "depth_detailed") {
    await db.update(userSessionsTable).set({ depthMode: "detailed", updatedAt: new Date() }).where(eq(userSessionsTable.id, session.id));
    await bot.sendMessage(chatId, TEXTS.deepIntro, { parse_mode: "Markdown" });
    await handleLaundryQuestion(bot, chatId, session);
    return;
  }

  if (data === "depth_savings") {
    await db.update(userSessionsTable).set({ depthMode: "savings", updatedAt: new Date() }).where(eq(userSessionsTable.id, session.id));
    await bot.sendMessage(chatId, TEXTS.quickSavingsIntro, {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[{ text: "Пройти разбор по категориям", callback_data: "depth_quick" }], [{ text: "📊 Таблица 13 категорий", callback_data: "show_table_quick" }]] }
    });
    return;
  }

  if (data === "show_table" || data === "show_table_quick") { await sendCalcTable(bot, chatId); return; }
  if (data === "back_to_conclusion") {
    await bot.sendMessage(chatId, TEXTS.calculationConclusion, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "Дальше →", callback_data: "calc_conclusion" }]] } });
    return;
  }

  if (data === "calc_conclusion") {
    await updateStage(session.id, "calculation_conclusion");
    await bot.sendMessage(chatId, TEXTS.calculationConclusion, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "Дальше →", callback_data: "company_video" }]] } });
    return;
  }
  if (data === "company_video") {
    await updateStage(session.id, "company_video");
    await bot.sendMessage(chatId, TEXTS.companyVideo, { parse_mode: "Markdown" });
    await sendVideo(bot, chatId, "company_video");
    await bot.sendMessage(chatId, "Теперь понятнее, что Greenleaf — это не просто ещё одно средство для дома.", { reply_markup: { inline_keyboard: [[{ text: "Дальше →", callback_data: "quality_block" }]] } });
    return;
  }
  if (data === "quality_block") {
    await updateStage(session.id, "quality_block");
    await bot.sendMessage(chatId, TEXTS.qualityBlock, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "Дальше →", callback_data: "purchase_interest" }]] } });
    return;
  }
  if (data === "purchase_interest") {
    await updateStage(session.id, "purchase_interest_question");
    await bot.sendMessage(chatId, TEXTS.purchaseInterestQuestion, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "Да, интересно", callback_data: "purchase_options" }], [{ text: "Расскажи подробнее", callback_data: "purchase_options" }]] } });
    return;
  }
  if (data === "purchase_options") {
    await updateStage(session.id, "purchase_options");
    await bot.sendMessage(chatId, TEXTS.purchaseOptions, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "Разобраться →", callback_data: "partnership_explain" }]] } });
    return;
  }
  if (data === "partnership_explain") {
    await updateStage(session.id, "partnership_explain");
    await bot.sendMessage(chatId, TEXTS.partnershipExplain, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "Дальше →", callback_data: "starter_kit" }]] } });
    return;
  }
  if (data === "starter_kit") {
    await updateStage(session.id, "start_28900");
    await bot.sendMessage(chatId, TEXTS.starterKit, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "Дальше →", callback_data: "cashback_block" }]] } });
    return;
  }
  if (data === "cashback_block") {
    await updateStage(session.id, "cashback_10");
    await bot.sendMessage(chatId, TEXTS.cashback10, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "Дальше →", callback_data: "bonus_video_block" }]] } });
    return;
  }
  if (data === "bonus_video_block") {
    await updateStage(session.id, "bonus_video");
    await bot.sendMessage(chatId, TEXTS.bonusVideo, { parse_mode: "Markdown" });
    await sendVideo(bot, chatId, "bonus_video");
    await bot.sendMessage(chatId, TEXTS.bonusExplain, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "Дальше →", callback_data: "free_product" }]] } });
    return;
  }
  if (data === "free_product") {
    await updateStage(session.id, "free_product_logic");
    await bot.sendMessage(chatId, TEXTS.freeProductLogic, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "Дальше →", callback_data: "model_3x3_block" }]] } });
    return;
  }
  if (data === "model_3x3_block") {
    await updateStage(session.id, "model_3x3");
    await bot.sendMessage(chatId, TEXTS.model3x3, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "Дальше →", callback_data: "why_3_people" }]] } });
    return;
  }
  if (data === "why_3_people") {
    await updateStage(session.id, "why_show_to_3_people");
    await bot.sendMessage(chatId, TEXTS.why3People, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "Дальше →", callback_data: "model_result" }]] } });
    return;
  }
  if (data === "model_result") {
    await updateStage(session.id, "model_3x3_result");
    await bot.sendMessage(chatId, TEXTS.model3x3Result, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "Дальше →", callback_data: "final_logic_block" }]] } });
    return;
  }
  if (data === "final_logic_block") {
    await updateStage(session.id, "final_logic");
    await bot.sendMessage(chatId, TEXTS.finalLogic, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "Дальше →", callback_data: "final_q" }]] } });
    return;
  }
  if (data === "final_q") { await handleFinalQuestion(bot, chatId, session); return; }
  if (data === "lead_capture_start") { await handleLeadCapture(bot, chatId, session); return; }
  if (data === "final_doubt") {
    await updateStage(session.id, "doubt");
    await bot.sendMessage(chatId, TEXTS.doubt, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "Вернуться к расчёту", callback_data: "menu_calc" }], [{ text: "Связаться", callback_data: "menu_contact" }]] } });
    return;
  }

  // ── Laundry ──
  if (data === "laundry_short") {
    await updateStage(session.id, "laundry_short_or_details");
    await bot.sendMessage(chatId, TEXTS.laundryShort, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "К видео", callback_data: "laundry_video" }], [{ text: "К расчёту", callback_data: "laundry_calc" }]] } });
    return;
  }
  if (data === "laundry_detailed") {
    await updateStage(session.id, "laundry_short_or_details");
    await bot.sendMessage(chatId, TEXTS.laundryDetailed, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "К видео", callback_data: "laundry_video" }], [{ text: "К расчёту", callback_data: "laundry_calc" }]] } });
    return;
  }
  if (data === "laundry_video") {
    await updateStage(session.id, "laundry_video");
    await sendVideo(bot, chatId, "laundry_video");
    await bot.sendMessage(chatId, "Что для тебя было самым неожиданным?", { reply_markup: { inline_keyboard: [[{ text: "К продукции Greenleaf →", callback_data: "laundry_greenleaf" }]] } });
    return;
  }
  if (data === "continue_after_video_laundry_video" || data === "laundry_greenleaf") {
    await updateStage(session.id, "laundry_greenleaf");
    await bot.sendMessage(chatId, TEXTS.laundryGreenleaf, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "Подробнее", callback_data: "laundry_greenleaf_detail" }], [{ text: "К расчёту →", callback_data: "laundry_calc" }]] } });
    return;
  }
  if (data === "laundry_greenleaf_detail") {
    await bot.sendMessage(chatId, TEXTS.laundryGreenleafDetailed, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "К расчёту →", callback_data: "laundry_calc" }]] } });
    return;
  }
  if (data === "laundry_calc") {
    await updateStage(session.id, "laundry_calc");
    await bot.sendMessage(chatId, TEXTS.laundryCalc, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "Дальше — средство для посуды →", callback_data: "dish_start" }]] } });
    return;
  }

  // ── Dish ──
  if (data === "dish_start") { await handleDishQuestion(bot, chatId, session); return; }
  if (data === "dish_short") {
    await updateStage(session.id, "dish_short_or_details");
    await bot.sendMessage(chatId, TEXTS.dishShort, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "К видео", callback_data: "dish_video" }], [{ text: "К расчёту", callback_data: "dish_calc" }]] } });
    return;
  }
  if (data === "dish_detailed") {
    await updateStage(session.id, "dish_short_or_details");
    await bot.sendMessage(chatId, TEXTS.dishDetailed, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "К видео", callback_data: "dish_video" }], [{ text: "К расчёту", callback_data: "dish_calc" }]] } });
    return;
  }
  if (data === "dish_video") {
    await updateStage(session.id, "dish_video");
    await sendVideo(bot, chatId, "dish_video");
    await bot.sendMessage(chatId, "Что заметил?", { reply_markup: { inline_keyboard: [[{ text: "К продукции Greenleaf →", callback_data: "dish_greenleaf" }]] } });
    return;
  }
  if (data === "continue_after_video_dish_video" || data === "dish_greenleaf") {
    await updateStage(session.id, "dish_greenleaf");
    await bot.sendMessage(chatId, TEXTS.dishGreenleaf, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "К расчёту →", callback_data: "dish_calc" }]] } });
    return;
  }
  if (data === "dish_calc") {
    await updateStage(session.id, "dish_calc");
    await bot.sendMessage(chatId, TEXTS.dishCalc, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "Дальше — женская гигиена →", callback_data: "pads_start" }]] } });
    return;
  }

  // ── Pads ──
  if (data === "pads_start") { await handlePadsIntro(bot, chatId, session); return; }
  if (data === "pads_yes" || data === "pads_no") {
    const intent = data === "pads_yes" ? "affirmative" : "negative";
    await updateStage(session.id, "pads_reaction");
    const reaction = getPadsReaction(intent);
    await bot.sendMessage(chatId, reaction, { parse_mode: "Markdown" });
    await bot.sendMessage(chatId, TEXTS.padsShortComposition, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "Коротко", callback_data: "pads_short" }, { text: "Подробнее", callback_data: "pads_detailed" }], [{ text: "К видео", callback_data: "pads_video" }]] } });
    return;
  }
  if (data === "pads_short") {
    await updateStage(session.id, "pads_short_or_details");
    await bot.sendMessage(chatId, TEXTS.padsShort, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "К видео", callback_data: "pads_video" }], [{ text: "К расчёту", callback_data: "pads_calc" }]] } });
    return;
  }
  if (data === "pads_detailed") {
    await updateStage(session.id, "pads_short_or_details");
    await bot.sendMessage(chatId, TEXTS.padsDetailed, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "К видео", callback_data: "pads_video" }], [{ text: "К расчёту", callback_data: "pads_calc" }]] } });
    return;
  }
  if (data === "pads_video") {
    await updateStage(session.id, "pads_video");
    await sendVideo(bot, chatId, "pads_video");
    await bot.sendMessage(chatId, "Что для тебя было самым неожиданным?", { reply_markup: { inline_keyboard: [[{ text: "К продукции Greenleaf →", callback_data: "pads_greenleaf" }]] } });
    return;
  }
  if (data === "continue_after_video_pads_video" || data === "pads_greenleaf") {
    await updateStage(session.id, "pads_greenleaf");
    await bot.sendMessage(chatId, TEXTS.padsGreenleaf, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "К расчёту →", callback_data: "pads_calc" }]] } });
    return;
  }
  if (data === "pads_calc") {
    await updateStage(session.id, "pads_calc");
    await bot.sendMessage(chatId, TEXTS.padsCalc, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "Дальше — туалетная бумага →", callback_data: "toilet_start" }]] } });
    return;
  }

  // ── Toilet ──
  if (data === "toilet_start") { await handleToiletQuestion(bot, chatId, session); return; }
  if (data === "toilet_short") {
    await updateStage(session.id, "toilet_short_or_details");
    await bot.sendMessage(chatId, TEXTS.toiletShort, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "К видео", callback_data: "toilet_video" }], [{ text: "К расчёту", callback_data: "toilet_calc" }]] } });
    return;
  }
  if (data === "toilet_detailed") {
    await updateStage(session.id, "toilet_short_or_details");
    await bot.sendMessage(chatId, TEXTS.toiletDetailed, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "К видео", callback_data: "toilet_video" }], [{ text: "К расчёту", callback_data: "toilet_calc" }]] } });
    return;
  }
  if (data === "toilet_video") {
    await updateStage(session.id, "toilet_video");
    await sendVideo(bot, chatId, "toilet_video");
    await bot.sendMessage(chatId, "Что заметил?", { reply_markup: { inline_keyboard: [[{ text: "К продукции Greenleaf →", callback_data: "toilet_greenleaf" }]] } });
    return;
  }
  if (data === "continue_after_video_toilet_video" || data === "toilet_greenleaf") {
    await updateStage(session.id, "toilet_greenleaf");
    await bot.sendMessage(chatId, TEXTS.toiletGreenleaf, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "К расчёту →", callback_data: "toilet_calc" }]] } });
    return;
  }
  if (data === "toilet_calc") {
    await updateStage(session.id, "toilet_calc");
    await bot.sendMessage(chatId, TEXTS.toiletCalc, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "Дальше — большой расчёт →", callback_data: "family_q" }]] } });
    return;
  }
  if (data === "family_q") { await handleFamilyQuestion(bot, chatId, session); return; }
}

async function showMainMenu(
  bot: TelegramBot,
  chatId: number,
  session: BotSession,
  isAdminFlag: boolean,
  partner: typeof partnersTable.$inferSelect | null
) {
  const rows: InlineKeyboardButton[][] = [];

  // First row — scenario or calc
  if (session.isCompleted) {
    rows.push([{ text: "📊 Калькулятор", callback_data: "menu_calc" }]);
  } else {
    rows.push([{ text: "▶️ Продолжить разбор", callback_data: "menu_continue" }]);
  }

  // Second row — common actions
  const commonRow: InlineKeyboardButton[] = [];
  commonRow.push({ text: "📋 Моя заявка", callback_data: "menu_my_lead" });
  commonRow.push({ text: "❓ Задать вопрос", callback_data: "menu_question" });
  rows.push(commonRow);

  rows.push([{ text: "📞 Связаться", callback_data: "menu_contact" }]);

  // Partner row
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

  // Admin
  if (isAdminFlag) {
    rows.push([{ text: "⚙️ Админ-панель", callback_data: "admin_menu" }]);
  }

  // Restart always at bottom
  rows.push([{ text: "🔄 Начать заново", callback_data: "restart_confirm" }]);

  const title = partner
    ? `🏠 *Главное меню*\n\nПривет, *${partner.name}*! Ты партнёр Greenleaf.\n\nЭтап: \`${session.currentStage}\``
    : `🏠 *Главное меню*\n\nЭтап: \`${session.currentStage}\``;

  await bot.sendMessage(chatId, title, {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: rows },
  });
}

async function continueFromStage(bot: TelegramBot, chatId: number, session: BotSession) {
  const stage = session.currentStage;
  if (stage.startsWith("question_mode_")) {
    const prev = stage.replace("question_mode_", "");
    await updateStage(session.id, prev);
    await bot.sendMessage(chatId, "Вернулись к разбору!", { reply_markup: { inline_keyboard: [[{ text: "Продолжить →", callback_data: "menu_continue" }]] } });
    return;
  }
  const map: Record<string, () => Promise<void>> = {
    "intro": () => handleIntro(bot, chatId, session),
    "intro_video": () => handleDepthChoice(bot, chatId, session),
    "depth_choice": () => handleDepthChoice(bot, chatId, session),
    "laundry_question": () => handleLaundryQuestion(bot, chatId, session),
    "laundry_reaction": () => handleLaundryQuestion(bot, chatId, session),
    "dish_question": () => handleDishQuestion(bot, chatId, session),
    "dish_reaction": () => handleDishQuestion(bot, chatId, session),
    "pads_intro": () => handlePadsIntro(bot, chatId, session),
    "toilet_question": () => handleToiletQuestion(bot, chatId, session),
    "toilet_reaction": () => handleToiletQuestion(bot, chatId, session),
    "family_question": () => handleFamilyQuestion(bot, chatId, session),
    "big_calculation": () => handleBigCalculation(bot, chatId, session),
    "final_question": () => handleFinalQuestion(bot, chatId, session),
    "lead_capture_name": () => handleLeadCapture(bot, chatId, session),
  };
  const handler = map[stage];
  if (handler) { await handler(); }
  else { await bot.sendMessage(chatId, `Продолжаем с этапа: ${stage}`, { reply_markup: { inline_keyboard: [[{ text: "Начать заново", callback_data: "restart_confirm" }]] } }); }
}

// ─── Admin ─────────────────────────────────────────────────────────────────────

export async function showAdminMenu(bot: TelegramBot, chatId: number) {
  await bot.sendMessage(chatId, "⚙️ *Telegram-админка Greenleaf*\n\nВыбери раздел:", {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "📋 Заявки", callback_data: "admin_leads" }, { text: "👥 Партнёры", callback_data: "admin_partners" }],
        [{ text: "🎬 Видео", callback_data: "admin_videos" }, { text: "💰 Калькулятор", callback_data: "admin_calc" }],
        [{ text: "💬 Диалоги", callback_data: "admin_dialogs" }, { text: "⚙️ Настройки", callback_data: "admin_settings" }],
        [{ text: "🤖 ИИ / Proxy API", callback_data: "admin_ai" }, { text: "📊 Статистика", callback_data: "admin_stats" }],
        [{ text: "❌ Выйти", callback_data: "admin_exit" }],
      ]
    }
  });
}

export async function handleAdminCallback(bot: TelegramBot, query: CallbackQuery) {
  const chatId = query.message?.chat.id;
  const userId = query.from.id;
  if (!chatId) return;
  const data = query.data || "";
  await bot.answerCallbackQuery(query.id);

  if (data === "admin_leads") {
    const leads = await db.select().from(leadsTable).orderBy(desc(leadsTable.createdAt)).limit(10);
    if (leads.length === 0) { await bot.sendMessage(chatId, "📋 Заявок пока нет."); return; }
    for (const lead of leads) {
      let partnerInfo = "—";
      if (lead.partnerId) {
        const pRows = await db.select().from(partnersTable).where(eq(partnersTable.id, lead.partnerId));
        if (pRows[0]) partnerInfo = `${pRows[0].name} (${pRows[0].refCode})`;
      }
      const kb: InlineKeyboardButton[][] = [
        [{ text: "✅ В работе", callback_data: `lead_status_${lead.id}_в работе` }, { text: "🏆 Зарегистрирован", callback_data: `lead_status_${lead.id}_зарегистрирован` }],
        [{ text: "❌ Отказ", callback_data: `lead_status_${lead.id}_отказ` }, { text: "📁 Архив", callback_data: `lead_status_${lead.id}_архив` }],
      ];
      if (lead.status === "зарегистрирован" && !lead.convertedPartnerId) {
        kb.push([{ text: "👥 Создать партнёра из заявки", callback_data: `lead_to_partner_${lead.id}` }]);
      }
      await bot.sendMessage(chatId,
        `📋 *Заявка #${lead.id}*\nИмя: ${lead.name}\nКонтакт: ${lead.contact}\nСтатус: *${lead.status}*\nПартнёр: ${partnerInfo}\nДата: ${lead.createdAt.toLocaleString("ru")}`,
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: kb } }
      );
    }
    return;
  }

  if (data.startsWith("lead_status_")) {
    const rest = data.replace("lead_status_", "");
    const underscoreIdx = rest.indexOf("_");
    const leadId = parseInt(rest.substring(0, underscoreIdx), 10);
    const newStatus = rest.substring(underscoreIdx + 1);
    await db.update(leadsTable).set({ status: newStatus, updatedAt: new Date() }).where(eq(leadsTable.id, leadId));
    await bot.sendMessage(chatId, `✅ Статус заявки #${leadId} → *${newStatus}*`, { parse_mode: "Markdown" });
    return;
  }

  if (data.startsWith("lead_to_partner_")) {
    const leadId = parseInt(data.replace("lead_to_partner_", ""), 10);
    const lead = (await db.select().from(leadsTable).where(eq(leadsTable.id, leadId)))[0];
    if (!lead) { await bot.sendMessage(chatId, "Заявка не найдена."); return; }
    await db.insert(adminStateTable).values({ telegramUserId: userId, mode: "awaiting_partner_refcode", pendingAction: "create_partner_from_lead", payload: { leadId } as Record<string, unknown> })
      .onConflictDoUpdate({ target: adminStateTable.telegramUserId, set: { mode: "awaiting_partner_refcode", pendingAction: "create_partner_from_lead", payload: { leadId } as Record<string, unknown>, updatedAt: new Date() } });
    const suggested = (lead.name || "partner").toLowerCase().replace(/\s+/g, "").substring(0, 10);
    await bot.sendMessage(chatId, `Введи refCode для нового партнёра.\nПредлагается: \`${suggested}\``, { parse_mode: "Markdown" });
    return;
  }

  if (data === "admin_partners") {
    const partners = await db.select().from(partnersTable).orderBy(desc(partnersTable.createdAt)).limit(10);
    const botUsername = await getSetting("bot_username");
    if (partners.length === 0) {
      await bot.sendMessage(chatId, "👥 Партнёров нет.", { reply_markup: { inline_keyboard: [[{ text: "➕ Создать партнёра", callback_data: "admin_create_partner" }]] } });
      return;
    }
    for (const p of partners) {
      const link = botUsername ? `https://t.me/${botUsername}?start=${p.refCode}` : p.refCode;
      const leadsCount = (await db.select().from(leadsTable).where(eq(leadsTable.partnerId, p.id))).length;
      await bot.sendMessage(chatId,
        `👤 *${p.name}*\nrefCode: \`${p.refCode}\`\nСсылка: ${link}\nЗаявок: ${leadsCount}\n${p.isActive ? "✅ активен" : "❌ неактивен"}`,
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: p.isActive ? "❌ Деактивировать" : "✅ Активировать", callback_data: `toggle_partner_${p.id}_${p.isActive ? "false" : "true"}` }], [{ text: "📋 Заявки", callback_data: `partner_leads_admin_${p.id}` }]] } }
      );
    }
    await bot.sendMessage(chatId, "Создать нового:", { reply_markup: { inline_keyboard: [[{ text: "➕ Создать партнёра", callback_data: "admin_create_partner" }]] } });
    return;
  }

  if (data === "admin_create_partner") {
    await db.insert(adminStateTable).values({ telegramUserId: userId, mode: "awaiting_partner_name", pendingAction: "create_partner", payload: {} as Record<string, unknown> })
      .onConflictDoUpdate({ target: adminStateTable.telegramUserId, set: { mode: "awaiting_partner_name", pendingAction: "create_partner", payload: {} as Record<string, unknown>, updatedAt: new Date() } });
    await bot.sendMessage(chatId, "Введи имя нового партнёра:");
    return;
  }

  if (data.startsWith("toggle_partner_")) {
    const parts = data.replace("toggle_partner_", "").split("_");
    const partnerId = parseInt(parts[0], 10);
    const newActive = parts[1] === "true";
    await db.update(partnersTable).set({ isActive: newActive, updatedAt: new Date() }).where(eq(partnersTable.id, partnerId));
    await bot.sendMessage(chatId, `Партнёр ${newActive ? "✅ активирован" : "❌ деактивирован"}.`);
    return;
  }

  if (data.startsWith("partner_leads_admin_")) {
    const partnerId = parseInt(data.replace("partner_leads_admin_", ""), 10);
    const leads = await db.select().from(leadsTable).where(eq(leadsTable.partnerId, partnerId));
    if (leads.length === 0) { await bot.sendMessage(chatId, "Заявок нет."); return; }
    let t = "📋 *Заявки партнёра:*\n\n";
    for (const l of leads) t += `• ${l.name} (${l.contact}) — *${l.status}* — ${l.createdAt.toLocaleDateString("ru")}\n`;
    await bot.sendMessage(chatId, t, { parse_mode: "Markdown" });
    return;
  }

  if (data === "admin_videos") {
    const videos = await db.select().from(videoBlocksTable);
    for (const v of videos) {
      await bot.sendMessage(chatId,
        `🎬 *${v.title}*\nKey: \`${v.key}\`\nURL: ${v.url || "_не задан_"}\n${v.isActive ? "✅ активно" : "❌ выключено"}`,
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "✏️ Изменить ссылку", callback_data: `admin_edit_video_${v.id}` }], [{ text: v.isActive ? "❌ Выключить" : "✅ Включить", callback_data: `toggle_video_${v.id}_${v.isActive ? "false" : "true"}` }]] } }
      );
    }
    return;
  }

  if (data.startsWith("admin_edit_video_")) {
    const videoId = parseInt(data.replace("admin_edit_video_", ""), 10);
    await db.insert(adminStateTable).values({ telegramUserId: userId, mode: "awaiting_video_url", pendingAction: "edit_video", payload: { videoId } as Record<string, unknown> })
      .onConflictDoUpdate({ target: adminStateTable.telegramUserId, set: { mode: "awaiting_video_url", pendingAction: "edit_video", payload: { videoId } as Record<string, unknown>, updatedAt: new Date() } });
    await bot.sendMessage(chatId, "Отправь новую ссылку (или «—» для удаления):");
    return;
  }

  if (data.startsWith("toggle_video_")) {
    const parts = data.replace("toggle_video_", "").split("_");
    const videoId = parseInt(parts[0], 10);
    const newActive = parts[1] === "true";
    await db.update(videoBlocksTable).set({ isActive: newActive, updatedAt: new Date() }).where(eq(videoBlocksTable.id, videoId));
    await bot.sendMessage(chatId, `Видео ${newActive ? "✅ включено" : "❌ выключено"}.`);
    return;
  }

  if (data === "admin_calc") {
    const items = await db.select().from(calculatorItemsTable).orderBy(calculatorItemsTable.order);
    let t = "💰 *Калькулятор:*\n\n";
    let totalMass = 0, totalGreen = 0;
    for (const item of items) {
      if (!item.isActive) continue;
      totalMass += item.massMarketYearPrice;
      totalGreen += item.greenleafYearPrice;
      t += `${item.order}. ${item.category}: ${item.massMarketYearPrice} / ${item.greenleafYearPrice} ₽\n`;
    }
    t += `\n*Итого:* ${totalMass.toLocaleString("ru")} / ${totalGreen.toLocaleString("ru")} ₽\n*Экономия:* ${(totalMass - totalGreen).toLocaleString("ru")} ₽`;
    await bot.sendMessage(chatId, t, { parse_mode: "Markdown" });
    return;
  }

  if (data === "admin_ai") {
    const available = await isAiAvailable();
    const key = !!(process.env.PROXY_API_KEY || process.env.PROXY_API_TOKEN);
    await bot.sendMessage(chatId,
      `🤖 *Proxy API:*\n\nСтатус: ${available ? "✅ доступен" : "❌ недоступен"}\nKey: ${key ? "✅" : "❌"}\nURL: ${process.env.PROXY_API_BASE_URL || "https://api.proxyapi.ru/openai/v1"}\nМодель: ${process.env.PROXY_API_MODEL || "gpt-4o-mini"}`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "🔄 Тест", callback_data: "admin_ai_test" }]] } }
    );
    return;
  }

  if (data === "admin_ai_test") {
    await bot.sendMessage(chatId, "Тестирую...");
    const available = await isAiAvailable();
    await bot.sendMessage(chatId, available ? "✅ Proxy API работает!" : "❌ Proxy API недоступен.");
    return;
  }

  if (data === "admin_stats") {
    const totalSessions = await db.select().from(userSessionsTable);
    const totalLeads = await db.select().from(leadsTable);
    const completed = totalSessions.filter((s) => s.isCompleted).length;
    const registered = totalLeads.filter((l) => l.status === "зарегистрирован").length;
    await bot.sendMessage(chatId,
      `📊 *Статистика:*\n\nПользователей: ${totalSessions.length}\nЗавершили: ${completed}\nЗаявок: ${totalLeads.length}\nЗарегистрированы: ${registered}\nКонверсия → заявка: ${totalSessions.length ? Math.round((totalLeads.length / totalSessions.length) * 100) : 0}%`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (data === "admin_settings") {
    const settings = await db.select().from(appSettingsTable);
    let t = "⚙️ *Настройки:*\n\n";
    for (const s of settings) t += `\`${s.key}\`: ${s.value || "_не задано_"}\n`;
    await bot.sendMessage(chatId, t, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "✏️ Изменить", callback_data: "admin_edit_setting" }]] } });
    return;
  }

  if (data === "admin_edit_setting") {
    await db.insert(adminStateTable).values({ telegramUserId: userId, mode: "awaiting_setting_key", pendingAction: "edit_setting", payload: {} as Record<string, unknown> })
      .onConflictDoUpdate({ target: adminStateTable.telegramUserId, set: { mode: "awaiting_setting_key", pendingAction: "edit_setting", payload: {} as Record<string, unknown>, updatedAt: new Date() } });
    await bot.sendMessage(chatId, "Введи ключ настройки (например: bot_username, default_contact, admin_telegram_ids):");
    return;
  }

  if (data === "admin_dialogs") {
    const sessions = await db.select().from(userSessionsTable).orderBy(desc(userSessionsTable.updatedAt)).limit(5);
    for (const s of sessions) {
      const msgs = await db.select().from(messagesTable).where(eq(messagesTable.sessionId, s.id)).orderBy(desc(messagesTable.createdAt)).limit(2);
      let t = `💬 *@${s.username || "user"}* — этап: \`${s.currentStage}\`\nrefCode: ${s.refCode || "—"}\n\n`;
      for (const m of msgs.reverse()) t += `${m.role === "user" ? "👤" : "🤖"}: ${m.content.substring(0, 80)}\n`;
      await bot.sendMessage(chatId, t, { parse_mode: "Markdown" });
    }
    return;
  }

  if (data === "admin_exit") {
    await db.update(adminStateTable).set({ mode: "idle", pendingAction: null, payload: null, updatedAt: new Date() }).where(eq(adminStateTable.telegramUserId, userId));
    await bot.sendMessage(chatId, "Вышел из администраторского режима.");
    return;
  }
}

async function handleAdminInput(bot: TelegramBot, chatId: number, userId: number, session: BotSession, text: string, adminState: typeof adminStateTable.$inferSelect) {
  const mode = adminState.mode;
  const payload = (adminState.payload as Record<string, unknown>) || {};

  if (mode === "awaiting_partner_name") {
    await db.update(adminStateTable).set({ mode: "awaiting_partner_telegram", payload: { ...payload, name: text } as Record<string, unknown>, updatedAt: new Date() }).where(eq(adminStateTable.telegramUserId, userId));
    await bot.sendMessage(chatId, `Имя: ${text}\n\nВведи Telegram партнёра (@username, или «—» чтобы пропустить):`);
    return;
  }
  if (mode === "awaiting_partner_telegram") {
    await db.update(adminStateTable).set({ mode: "awaiting_partner_phone", payload: { ...payload, telegram: text === "—" ? "" : text } as Record<string, unknown>, updatedAt: new Date() }).where(eq(adminStateTable.telegramUserId, userId));
    await bot.sendMessage(chatId, "Введи телефон (или «—»):");
    return;
  }
  if (mode === "awaiting_partner_phone") {
    const suggested = String(payload.name || "partner").toLowerCase().replace(/\s+/g, "").substring(0, 10);
    await db.update(adminStateTable).set({ mode: "awaiting_partner_refcode_new", payload: { ...payload, phone: text === "—" ? "" : text } as Record<string, unknown>, updatedAt: new Date() }).where(eq(adminStateTable.telegramUserId, userId));
    await bot.sendMessage(chatId, `Введи refCode (только латиница/цифры).\nПредлагается: \`${suggested}\``, { parse_mode: "Markdown" });
    return;
  }
  if (mode === "awaiting_partner_refcode_new") {
    const existing = await db.select().from(partnersTable).where(eq(partnersTable.refCode, text));
    if (existing.length > 0) { await bot.sendMessage(chatId, "❌ Этот refCode уже занят. Введите другой:"); return; }
    const [partner] = await db.insert(partnersTable).values({ name: String(payload.name), telegram: String(payload.telegram) || null, phone: String(payload.phone) || null, refCode: text, isActive: true }).returning();
    await db.update(adminStateTable).set({ mode: "idle", pendingAction: null, payload: null, updatedAt: new Date() }).where(eq(adminStateTable.telegramUserId, userId));
    const botUsername = await getSetting("bot_username");
    const link = botUsername ? `https://t.me/${botUsername}?start=${text}` : `refCode: ${text}`;
    await bot.sendMessage(chatId, `✅ Партнёр создан!\nИмя: ${partner.name}\nСсылка: \`${link}\``, { parse_mode: "Markdown" });
    return;
  }
  if (mode === "awaiting_partner_refcode") {
    const existing = await db.select().from(partnersTable).where(eq(partnersTable.refCode, text));
    if (existing.length > 0) { await bot.sendMessage(chatId, "❌ Этот refCode уже занят. Введите другой:"); return; }
    const leadId = Number(payload.leadId);
    const lead = (await db.select().from(leadsTable).where(eq(leadsTable.id, leadId)))[0];
    if (!lead) { await bot.sendMessage(chatId, "Заявка не найдена."); return; }
    const sessionRow = (await db.select().from(userSessionsTable).where(eq(userSessionsTable.id, lead.sessionId)))[0];
    const [newPartner] = await db.insert(partnersTable).values({
      name: lead.name, telegram: lead.contact.startsWith("@") ? lead.contact : null,
      phone: !lead.contact.startsWith("@") ? lead.contact : null,
      refCode: text, telegramUserId: sessionRow?.telegramUserId || null,
      sponsorPartnerId: sessionRow?.partnerId || null, sourceLeadId: lead.id, isActive: true,
    }).returning();

    // Update all user sessions so they see partner menu immediately
    if (sessionRow?.telegramUserId) {
      await db.update(userSessionsTable)
        .set({ partnerId: newPartner.id, updatedAt: new Date() })
        .where(eq(userSessionsTable.telegramUserId, sessionRow.telegramUserId));
    }

    await db.update(leadsTable).set({ convertedPartnerId: newPartner.id, updatedAt: new Date() }).where(eq(leadsTable.id, leadId));
    await db.update(adminStateTable).set({ mode: "idle", pendingAction: null, payload: null, updatedAt: new Date() }).where(eq(adminStateTable.telegramUserId, userId));
    const botUsername = await getSetting("bot_username");
    const link = botUsername ? `https://t.me/${botUsername}?start=${text}` : `refCode: ${text}`;
    await bot.sendMessage(chatId, `✅ Партнёр создан из заявки!\nИмя: ${newPartner.name}\nСсылка: \`${link}\``, { parse_mode: "Markdown" });
    if (sessionRow?.telegramUserId && botUsername) {
      try { await bot.sendMessage(sessionRow.telegramUserId, `🎉 Ты теперь партнёр Greenleaf!\n\nТвоя ссылка:\n\`https://t.me/${botUsername}?start=${text}\`\n\nПоделись ею с 3 людьми!`, { parse_mode: "Markdown" }); } catch {}
    }
    return;
  }
  if (mode === "awaiting_video_url") {
    const videoId = Number(payload.videoId);
    const newUrl = text === "—" || text === "-" ? null : text;
    await db.update(videoBlocksTable).set({ url: newUrl, updatedAt: new Date() }).where(eq(videoBlocksTable.id, videoId));
    await db.update(adminStateTable).set({ mode: "idle", pendingAction: null, payload: null, updatedAt: new Date() }).where(eq(adminStateTable.telegramUserId, userId));
    await bot.sendMessage(chatId, `✅ Ссылка обновлена: ${newUrl || "_удалена_"}`, { parse_mode: "Markdown" });
    return;
  }
  if (mode === "awaiting_setting_key") {
    await db.update(adminStateTable).set({ mode: "awaiting_setting_value", payload: { key: text } as Record<string, unknown>, updatedAt: new Date() }).where(eq(adminStateTable.telegramUserId, userId));
    const current = (await db.select().from(appSettingsTable).where(eq(appSettingsTable.key, text)))[0];
    await bot.sendMessage(chatId, `Ключ: \`${text}\`\nТекущее: ${current?.value || "_не задано_"}\n\nВведи новое значение:`, { parse_mode: "Markdown" });
    return;
  }
  if (mode === "awaiting_setting_value") {
    const key = String(payload.key);
    await db.insert(appSettingsTable).values({ key, value: text }).onConflictDoUpdate({ target: appSettingsTable.key, set: { value: text, updatedAt: new Date() } });
    await db.update(adminStateTable).set({ mode: "idle", pendingAction: null, payload: null, updatedAt: new Date() }).where(eq(adminStateTable.telegramUserId, userId));
    await bot.sendMessage(chatId, `✅ \`${key}\` → ${text}`, { parse_mode: "Markdown" });
    return;
  }

  await db.update(adminStateTable).set({ mode: "idle", pendingAction: null, payload: null, updatedAt: new Date() }).where(eq(adminStateTable.telegramUserId, userId));
  await bot.sendMessage(chatId, "Непонятная команда. Вышел из режима администратора.");
}
