import axios from "axios";
import TelegramBot from "node-telegram-bot-api";
import type { CallbackQuery, Message } from "node-telegram-bot-api";
import { and, eq } from "drizzle-orm";
import { db, leadsTable, partnersTable, userSessionsTable } from "@workspace/db";
import { handleCallback, handleMessage } from "../bot/engine-v2.js";
import { attachSavingsTableFormatter } from "../bot/savings-table-format.js";
import { logger } from "../lib/logger.js";
import {
  VkEventDeduplicator,
  buildVkKeyboard,
  chooseReferralCode,
  evaluateVkCallback,
  extractCallbackData,
  extractReferralCode,
  fromVkSyntheticUserId,
  toVkSyntheticUserId,
  type VkCallbackBody,
  type VkIncomingMessage,
} from "./protocol.js";

const VK_API_URL = "https://api.vk.com/method";
const VK_MAX_MESSAGE_LENGTH = 3500;
const VK_EVENT_DEDUP_TTL_MS = readPositiveInt(process.env.VK_EVENT_DEDUP_TTL_MS, 10 * 60_000);
const VK_USER_MIN_INTERVAL_MS = readPositiveInt(process.env.VK_USER_MIN_INTERVAL_MS, 500);

const deduplicator = new VkEventDeduplicator(VK_EVENT_DEDUP_TTL_MS);
const userQueues = new Map<number, Promise<void>>();
const userLastHandledAt = new Map<number, number>();

function readPositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function splitMessage(text: string): string[] {
  if (text.length <= VK_MAX_MESSAGE_LENGTH) return [text];

  const chunks: string[] = [];
  let rest = text;
  while (rest.length > VK_MAX_MESSAGE_LENGTH) {
    const candidate = rest.slice(0, VK_MAX_MESSAGE_LENGTH);
    const breakAt = Math.max(candidate.lastIndexOf("\n"), candidate.lastIndexOf(" "));
    const size = breakAt > VK_MAX_MESSAGE_LENGTH * 0.6 ? breakAt : VK_MAX_MESSAGE_LENGTH;
    chunks.push(rest.slice(0, size).trim());
    rest = rest.slice(size).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function stripTelegramMarkup(text: string): string {
  return decodeHtmlEntities(text)
    .replace(/<\/?(?:b|strong|i|em|u|s|code|pre)>/gi, "")
    .replace(/<a\s+href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi, "$2 ($1)")
    .replace(/<[^>]+>/g, "")
    .replace(/\\([_\-*\[\]()~`>#+=|{}.!])/g, "$1")
    .replace(/```[a-z]*\n?/gi, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1");
}

function notificationWithSource(text: string): string {
  if (!text.startsWith("🆕 Новая заявка") || /Источник:/i.test(text)) return text;
  return `${text}\nИсточник: VK`;
}

function rewriteTelegramLinksForVk(text: string): string {
  const groupScreenName = process.env.VK_GROUP_SCREEN_NAME?.trim();
  if (!groupScreenName) return text;

  return text
    .replace(
      /https:\/\/t\.me\/[^\s?]+\?start=([A-Za-z0-9_-]+)/g,
      (_match, refCode: string) => `https://vk.me/${groupScreenName}?ref=${encodeURIComponent(refCode)}&ref_source=partner`,
    )
    .replace(
      /Открой меню бота и нажми ["«]📞 Партнёрам["»] — там всё для работы с ссылкой\.?/gi,
      "Нажми «☰ Меню» — там появятся партнёрские инструменты и твоя ссылка.",
    );
}

function normalizeVkOutboundText(text: string): string {
  return stripTelegramMarkup(rewriteTelegramLinksForVk(notificationWithSource(text)));
}

type VkProfile = {
  id: number;
  first_name?: string;
  last_name?: string;
  domain?: string;
};

class VkApiClient {
  private readonly token = process.env.VK_GROUP_TOKEN?.trim() || "";
  private readonly version = process.env.VK_API_VERSION?.trim() || "5.199";

  isConfigured(): boolean {
    return Boolean(this.token && process.env.VK_GROUP_ID?.trim());
  }

  private async call<T>(method: string, params: Record<string, string | number>): Promise<T> {
    if (!this.token) throw new Error("VK_GROUP_TOKEN is not configured");

    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) form.set(key, String(value));
    form.set("access_token", this.token);
    form.set("v", this.version);

    const response = await axios.post<{ response?: T; error?: { error_code?: number; error_msg?: string } }>(
      `${VK_API_URL}/${method}`,
      form,
      {
        timeout: 15_000,
        headers: { "content-type": "application/x-www-form-urlencoded" },
      },
    );

    if (response.data.error) {
      const error = response.data.error;
      throw new Error(`VK API ${method} failed (${error.error_code || "unknown"}): ${error.error_msg || "unknown error"}`);
    }

    return response.data.response as T;
  }

  async sendMessage(peerId: number, text: string, keyboard?: unknown): Promise<number> {
    return this.call<number>("messages.send", {
      peer_id: peerId,
      random_id: Math.floor(Math.random() * 2_000_000_000) + 1,
      message: text,
      ...(keyboard ? { keyboard: JSON.stringify(keyboard) } : {}),
    });
  }

  async getProfile(userId: number): Promise<VkProfile | null> {
    try {
      const profiles = await this.call<VkProfile[]>("users.get", {
        user_ids: userId,
        fields: "domain",
      });
      return profiles[0] || null;
    } catch (err) {
      logger.warn({ err, vkUserId: userId }, "Failed to load VK profile");
      return null;
    }
  }
}

const vkClient = new VkApiClient();

function syntheticVkMessage(chatId: number, text: string, messageId = 0): Message {
  return {
    message_id: messageId,
    date: Math.floor(Date.now() / 1000),
    chat: { id: chatId, type: "private" },
    text,
  } as Message;
}

export async function sendVkMessageToSyntheticUser(
  syntheticUserId: number,
  text: string,
  options: TelegramBot.SendMessageOptions = {},
): Promise<Message> {
  const vkUserId = fromVkSyntheticUserId(syntheticUserId);
  if (!vkUserId) throw new Error(`Invalid VK synthetic user id: ${syntheticUserId}`);
  if (!vkClient.isConfigured()) throw new Error("VK client is not configured");

  const session = (await db
    .select({ partnerId: userSessionsTable.partnerId })
    .from(userSessionsTable)
    .where(eq(userSessionsTable.telegramUserId, syntheticUserId))
    .limit(1))[0];

  const keyboard = buildVkKeyboard(
    options.reply_markup as unknown as Parameters<typeof buildVkKeyboard>[0],
    Boolean(session?.partnerId),
  );
  const normalizedText = normalizeVkOutboundText(text);
  const chunks = splitMessage(normalizedText);

  let messageId = 0;
  for (let index = 0; index < chunks.length; index += 1) {
    messageId = await vkClient.sendMessage(
      vkUserId,
      chunks[index] || " ",
      index === chunks.length - 1 ? keyboard : undefined,
    );
  }

  return syntheticVkMessage(syntheticUserId, normalizedText, messageId);
}

class VkTelegramAdapter {
  constructor(private readonly telegramBot: TelegramBot | null) {}

  async sendMessage(
    chatId: number | string,
    text: string,
    options: TelegramBot.SendMessageOptions = {},
  ): Promise<Message> {
    const numericChatId = Number(chatId);
    const vkUserId = fromVkSyntheticUserId(numericChatId);

    if (!vkUserId) {
      if (!this.telegramBot) {
        logger.warn({ chatId: numericChatId }, "Telegram notification skipped because Telegram bot is unavailable");
        return syntheticVkMessage(numericChatId, notificationWithSource(text));
      }
      return this.telegramBot.sendMessage(numericChatId, notificationWithSource(text), options);
    }

    return sendVkMessageToSyntheticUser(numericChatId, text, options);
  }

  async answerCallbackQuery(_callbackQueryId: string): Promise<boolean> {
    return true;
  }

  async getMe(): Promise<TelegramBot.User> {
    return {
      id: 0,
      is_bot: true,
      first_name: "Greenleaf",
      username: process.env.VK_GROUP_SCREEN_NAME?.trim() || "greenleaf_vk",
    };
  }
}

function makeSyntheticMessage(
  message: VkIncomingMessage,
  profile: VkProfile | null,
  text: string,
): Message {
  const vkUserId = Number(message.from_id || message.peer_id || 0);
  const syntheticUserId = toVkSyntheticUserId(vkUserId);
  return {
    message_id: message.id || message.conversation_message_id || 0,
    date: message.date || Math.floor(Date.now() / 1000),
    chat: { id: syntheticUserId, type: "private" },
    from: {
      id: syntheticUserId,
      is_bot: false,
      first_name: profile?.first_name || "Пользователь VK",
      last_name: profile?.last_name,
      username: profile?.domain,
    },
    text,
  } as Message;
}

function makeSyntheticCallback(message: Message, callbackData: string): CallbackQuery {
  return {
    id: `vk_${message.message_id}_${Date.now()}`,
    from: message.from!,
    message,
    chat_instance: String(message.chat.id),
    data: callbackData,
  };
}

async function runForVkUser(userId: number, task: () => Promise<void>): Promise<void> {
  const previous = userQueues.get(userId) || Promise.resolve();
  let current: Promise<void>;

  current = previous
    .catch(() => undefined)
    .then(async () => {
      const lastHandledAt = userLastHandledAt.get(userId) || 0;
      const waitMs = Math.max(0, VK_USER_MIN_INTERVAL_MS - (Date.now() - lastHandledAt));
      if (waitMs > 0) await sleep(waitMs);
      userLastHandledAt.set(userId, Date.now());
      await task();
    })
    .finally(() => {
      if (userQueues.get(userId) === current) userQueues.delete(userId);
    });

  userQueues.set(userId, current);
  await current;
}

async function markVkSource(syntheticUserId: number, vkUserId: number, profile: VkProfile | null): Promise<void> {
  const [session] = await db
    .update(userSessionsTable)
    .set({
      platform: "vk",
      platformUserId: String(vkUserId),
      username: profile?.domain || undefined,
      updatedAt: new Date(),
    })
    .where(eq(userSessionsTable.telegramUserId, syntheticUserId))
    .returning();

  if (session?.leadId) {
    await db
      .update(leadsTable)
      .set({ source: "vk", updatedAt: new Date() })
      .where(eq(leadsTable.id, session.leadId));
  }
}

async function processVkMessage(body: VkCallbackBody, telegramBot: TelegramBot | null): Promise<void> {
  const message = body.object?.message;
  if (!message) return;

  const vkUserId = Number(message.from_id || message.peer_id || 0);
  if (!Number.isSafeInteger(vkUserId) || vkUserId <= 0) return;

  const syntheticUserId = toVkSyntheticUserId(vkUserId);
  const existing = (await db
    .select()
    .from(userSessionsTable)
    .where(eq(userSessionsTable.telegramUserId, syntheticUserId))
    .limit(1))[0];

  const referralCandidate = extractReferralCode(body, message);
  let candidateIsActive = false;
  if (referralCandidate) {
    candidateIsActive = Boolean((await db
      .select({ id: partnersTable.id })
      .from(partnersTable)
      .where(and(eq(partnersTable.refCode, referralCandidate), eq(partnersTable.isActive, true)))
      .limit(1))[0]);
  }
  const referralCode = chooseReferralCode(existing?.refCode, referralCandidate, candidateIsActive);

  const profile = await vkClient.getProfile(vkUserId);
  const adapter = new VkTelegramAdapter(telegramBot);
  attachSavingsTableFormatter(adapter as unknown as TelegramBot);

  const callbackData = extractCallbackData(message.payload);
  const originalText = message.text?.trim() || "";
  const manualStart = /^(?:\/?start|начать|старт)$/iu.test(originalText);
  const shouldStart = !existing || Boolean(referralCode && !existing.refCode) || manualStart;
  const effectiveText = shouldStart
    ? `/start${referralCode ? ` ${referralCode}` : ""}`
    : originalText;
  const syntheticMessage = makeSyntheticMessage(message, profile, effectiveText || "☰ Меню");

  if (callbackData && existing) {
    await handleCallback(adapter as unknown as TelegramBot, makeSyntheticCallback(syntheticMessage, callbackData));
  } else {
    await handleMessage(adapter as unknown as TelegramBot, syntheticMessage);
  }

  await markVkSource(syntheticUserId, vkUserId, profile);
}

export function getVkCallbackDecision(body: VkCallbackBody) {
  return evaluateVkCallback(body, {
    callbackSecret: process.env.VK_CALLBACK_SECRET,
    confirmationCode: process.env.VK_CONFIRMATION_CODE,
    groupId: process.env.VK_GROUP_ID,
  });
}

export async function handleVkCallbackEvent(
  body: VkCallbackBody,
  telegramBot: TelegramBot | null,
): Promise<void> {
  if (!vkClient.isConfigured()) {
    logger.warn("VK callback received but VK_GROUP_TOKEN or VK_GROUP_ID is not configured");
    return;
  }

  if (!deduplicator.shouldProcess(body.event_id)) {
    logger.info({ eventId: body.event_id }, "Duplicate VK event ignored");
    return;
  }

  const message = body.object?.message;
  const vkUserId = Number(message?.from_id || message?.peer_id || 0);
  if (!Number.isSafeInteger(vkUserId) || vkUserId <= 0) return;

  try {
    await runForVkUser(vkUserId, () => processVkMessage(body, telegramBot));
  } catch (err) {
    logger.error({ err, eventId: body.event_id, vkUserId }, "VK event handler error");
  }
}
