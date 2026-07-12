import TelegramBot from "node-telegram-bot-api";
import type { Update } from "node-telegram-bot-api";
import { logger } from "../lib/logger.js";
import { handleMessage, handleCallback, handleAdminCallback } from "./engine-v2.js";
import { seedDatabase } from "./seed.js";
import { seedV2Content } from "./content-store-v2.js";
import { attachSavingsTableFormatter } from "./savings-table-format.js";
import { sendVkMessageToSyntheticUser } from "../vk/index.js";
import { db } from "@workspace/db";
import { appSettingsTable } from "@workspace/db";

const UPDATE_DEDUP_TTL_MS = readPositiveInt(process.env.TELEGRAM_UPDATE_DEDUP_TTL_MS, 10 * 60_000);
const USER_MIN_INTERVAL_MS = readPositiveInt(process.env.TELEGRAM_USER_MIN_INTERVAL_MS, 500);
const processedUpdates = new Map<number, number>();
const userQueues = new Map<number, Promise<void>>();
const userLastHandledAt = new Map<number, number>();
const crossPlatformBots = new WeakSet<TelegramBot>();

let bot: TelegramBot | null = null;
let shutdownHandlersInstalled = false;

function readPositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isDuplicateUpdate(updateId: number): boolean {
  const now = Date.now();
  for (const [id, expiresAt] of processedUpdates) {
    if (expiresAt <= now) processedUpdates.delete(id);
  }

  if (processedUpdates.has(updateId)) return true;
  processedUpdates.set(updateId, now + UPDATE_DEDUP_TTL_MS);
  return false;
}

async function runForUser(userId: number, task: () => Promise<void>): Promise<void> {
  const previous = userQueues.get(userId) ?? Promise.resolve();
  let current: Promise<void>;

  current = previous
    .catch(() => undefined)
    .then(async () => {
      const lastHandledAt = userLastHandledAt.get(userId) ?? 0;
      const waitMs = Math.max(0, USER_MIN_INTERVAL_MS - (Date.now() - lastHandledAt));
      if (waitMs > 0) await sleep(waitMs);

      userLastHandledAt.set(userId, Date.now());
      await task();
    })
    .finally(() => {
      if (userQueues.get(userId) === current) userQueues.delete(userId);
      const lastHandledAt = userLastHandledAt.get(userId) ?? 0;
      if (Date.now() - lastHandledAt > UPDATE_DEDUP_TTL_MS) userLastHandledAt.delete(userId);
    });

  userQueues.set(userId, current);
  await current;
}

function attachBotErrorHandlers(instance: TelegramBot): void {
  instance.on("error", (err) => {
    logger.error({ err }, "Telegram bot error");
  });

  instance.on("webhook_error", (err) => {
    logger.error({ err }, "Telegram webhook error");
  });
}

function attachCrossPlatformSender(instance: TelegramBot): void {
  if (crossPlatformBots.has(instance)) return;
  crossPlatformBots.add(instance);

  const originalSendMessage = instance.sendMessage.bind(instance);
  instance.sendMessage = (async (
    chatId: Parameters<TelegramBot["sendMessage"]>[0],
    text: Parameters<TelegramBot["sendMessage"]>[1],
    options?: Parameters<TelegramBot["sendMessage"]>[2],
  ) => {
    const numericChatId = Number(chatId);
    if (Number.isSafeInteger(numericChatId) && numericChatId < 0) {
      return sendVkMessageToSyntheticUser(numericChatId, text, options || {});
    }
    return originalSendMessage(chatId, text, options);
  }) as TelegramBot["sendMessage"];
}

function prepareBotInstance(instance: TelegramBot): TelegramBot {
  attachSavingsTableFormatter(instance);
  attachCrossPlatformSender(instance);
  attachBotErrorHandlers(instance);
  return instance;
}

async function storeBotUsername(username: string): Promise<void> {
  if (!username) return;
  await db
    .insert(appSettingsTable)
    .values({ key: "bot_username", value: username })
    .onConflictDoUpdate({
      target: appSettingsTable.key,
      set: { value: username, updatedAt: new Date() },
    });
  logger.info({ username }, "Bot username stored");
}

async function storeLiveBotUsername(instance: TelegramBot): Promise<void> {
  try {
    const me = await instance.getMe();
    if (me.username) await storeBotUsername(me.username);
  } catch (err) {
    logger.error({ err }, "Failed to get bot info");
  }
}

function createOutboundOnlyBot(token: string): TelegramBot {
  return prepareBotInstance(new TelegramBot(token, { polling: false, webHook: false }));
}

function createVkBridgeBot(): TelegramBot {
  return prepareBotInstance(new TelegramBot("0:vk-bridge", { polling: false, webHook: false }));
}

function installShutdownHandlers(): void {
  if (shutdownHandlersInstalled) return;
  shutdownHandlersInstalled = true;

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Stopping Telegram bot");
    const currentBot = bot;
    bot = null;
    if (!currentBot) return;

    try {
      if (currentBot.isPolling()) await currentBot.stopPolling({ cancel: true });
    } catch (err) {
      logger.warn({ err }, "Failed to stop Telegram polling cleanly");
    }
  };

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

async function dispatchCallback(instance: TelegramBot, query: NonNullable<Update["callback_query"]>): Promise<void> {
  const data = query.data || "";
  if (
    data.startsWith("admin_") ||
    data.startsWith("lead_status_") ||
    data.startsWith("lead_to_partner_") ||
    data.startsWith("toggle_") ||
    data.startsWith("partner_leads_admin_")
  ) {
    await handleAdminCallback(instance, query);
  } else {
    await handleCallback(instance, query);
  }
}

export async function startBot(webhookUrl?: string): Promise<void> {
  const receiverToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const notificationToken = process.env.TELEGRAM_NOTIFICATION_BOT_TOKEN?.trim();
  const vkScreenName = process.env.VK_GROUP_SCREEN_NAME?.trim();
  const vkConfigured = Boolean(process.env.VK_GROUP_TOKEN?.trim() && process.env.VK_GROUP_ID?.trim());

  await seedDatabase();
  await seedV2Content();
  installShutdownHandlers();

  if (!receiverToken) {
    if (notificationToken) {
      bot = createOutboundOnlyBot(notificationToken);
      await storeLiveBotUsername(bot);
      logger.info("Telegram outbound notifications enabled; receiver remains disabled");
    } else if (vkConfigured) {
      bot = createVkBridgeBot();
      if (vkScreenName) await storeBotUsername(vkScreenName);
      logger.info("VK bridge sender enabled; Telegram receiver remains disabled");
    } else {
      logger.warn("TELEGRAM_BOT_TOKEN not set — Telegram receiver will not start");
    }
    return;
  }

  const token = receiverToken;
  bot = prepareBotInstance(new TelegramBot(token, { polling: false, webHook: false }));
  await storeLiveBotUsername(bot);

  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  let webhookConfigured = false;

  if (webhookUrl) {
    try {
      await bot.setWebHook(
        webhookUrl,
        webhookSecret ? { secret_token: webhookSecret } : undefined,
      );
      webhookConfigured = true;
      logger.info(
        { webhookUrl, protected: Boolean(webhookSecret) },
        "Telegram webhook set",
      );
      if (!webhookSecret) {
        logger.warn("TELEGRAM_WEBHOOK_SECRET is not set — webhook is not header-protected");
      }
    } catch (err) {
      logger.error({ err, webhookUrl }, "Failed to set webhook — falling back to polling");
    }
  }

  let webhookActive = false;
  try {
    const webhookInfo = await bot.getWebHookInfo();
    webhookActive = Boolean(
      webhookConfigured && webhookInfo.url && webhookInfo.url === webhookUrl,
    );
  } catch (err) {
    logger.error({ err }, "Failed to read Telegram webhook status");
  }

  if (!webhookActive) {
    if (webhookUrl) logger.warn("Webhook not active — falling back to polling");

    try {
      await bot.deleteWebHook({ drop_pending_updates: false });
      logger.info("Previous Telegram webhook removed before polling");
    } catch (err) {
      logger.error({ err }, "Failed to remove Telegram webhook before polling");
      throw err;
    }

    bot = prepareBotInstance(new TelegramBot(token, { polling: true }));

    bot.on("message", async (msg) => {
      const userId = msg.from?.id;
      if (!userId) return;

      try {
        await runForUser(userId, () => handleMessage(bot!, msg));
      } catch (err) {
        logger.error({ err, chatId: msg.chat.id, userId }, "Error handling message");
        try {
          await bot!.sendMessage(msg.chat.id, "Что-то пошло не так. Попробуй ещё раз или нажми /start");
        } catch (sendErr) {
          logger.error({ err: sendErr, chatId: msg.chat.id }, "Failed to send fallback error message");
        }
      }
    });

    bot.on("callback_query", async (query) => {
      try {
        await runForUser(query.from.id, () => dispatchCallback(bot!, query));
      } catch (err) {
        logger.error({ err, userId: query.from.id }, "Error handling callback query");
      }
    });

    bot.on("polling_error", (err) => {
      logger.error({ err }, "Telegram polling error");
    });

    logger.info("Telegram bot started in polling mode");
  } else {
    logger.info("Telegram bot started in webhook mode");
  }
}

export function getBot(): TelegramBot | null {
  return bot;
}

export async function handleWebhookUpdate(update: Update): Promise<void> {
  const currentBot = getBot();
  if (!currentBot) {
    logger.warn("Bot not initialized — skipping webhook update");
    return;
  }

  if (isDuplicateUpdate(update.update_id)) {
    logger.info({ updateId: update.update_id }, "Duplicate Telegram update ignored");
    return;
  }

  try {
    if (update.message) {
      const userId = update.message.from?.id;
      if (!userId) return;
      await runForUser(userId, () => handleMessage(currentBot, update.message!));
    } else if (update.callback_query) {
      await runForUser(update.callback_query.from.id, () => dispatchCallback(currentBot, update.callback_query!));
    }
  } catch (err) {
    logger.error({ err, updateId: update.update_id }, "Error handling webhook update");
  }
}
