import TelegramBot from "node-telegram-bot-api";
import type { Update } from "node-telegram-bot-api";
import { logger } from "../lib/logger.js";
import { handleMessage, handleCallback, handleAdminCallback } from "./engine.js";
import { seedDatabase } from "./seed.js";
import { db } from "@workspace/db";
import { appSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

let bot: TelegramBot | null = null;

export async function startBot(webhookUrl?: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    logger.warn("TELEGRAM_BOT_TOKEN not set — bot will not start");
    return;
  }

  // Run DB migrations/seed
  await seedDatabase();

  bot = new TelegramBot(token, { polling: false, webHook: false });

  // Store bot username in settings
  try {
    const me = await bot.getMe();
    if (me.username) {
      await db.insert(appSettingsTable).values({ key: "bot_username", value: me.username })
        .onConflictDoUpdate({ target: appSettingsTable.key, set: { value: me.username, updatedAt: new Date() } });
      logger.info({ username: me.username }, "Bot username stored");
    }
  } catch (err) {
    logger.error({ err }, "Failed to get bot info");
  }

  // If webhook URL is provided, use webhook mode; otherwise fallback to polling
  if (webhookUrl) {
    try {
      await bot.setWebHook(webhookUrl);
      logger.info({ webhookUrl }, "Telegram webhook set");
    } catch (err) {
      logger.error({ err, webhookUrl }, "Failed to set webhook — falling back to polling");
    }
  }

  // Check if webhook is actually active
  const webhookInfo = await bot.getWebHookInfo();
  if (!webhookInfo.url || webhookInfo.url !== webhookUrl) {
    // Webhook not active — use polling
    if (webhookUrl) {
      logger.warn("Webhook not active — falling back to polling");
    }
    bot = new TelegramBot(token, { polling: true });

    bot.on("message", async (msg) => {
      try {
        await handleMessage(bot!, msg);
      } catch (err) {
        logger.error({ err, chatId: msg.chat.id }, "Error handling message");
        try {
          await bot!.sendMessage(msg.chat.id, "Что-то пошло не так. Попробуй ещё раз или нажми /start");
        } catch {}
      }
    });

    bot.on("callback_query", async (query) => {
      try {
        const data = query.data || "";
        if (data.startsWith("admin_") || data.startsWith("lead_status_") ||
            data.startsWith("lead_to_partner_") || data.startsWith("toggle_") ||
            data.startsWith("partner_leads_admin_")) {
          await handleAdminCallback(bot!, query);
        } else {
          await handleCallback(bot!, query);
        }
      } catch (err) {
        logger.error({ err }, "Error handling callback query");
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
  const b = getBot();
  if (!b) {
    logger.warn("Bot not initialized — skipping webhook update");
    return;
  }

  try {
    if (update.message) {
      await handleMessage(b, update.message);
    } else if (update.callback_query) {
      const data = update.callback_query.data || "";
      if (data.startsWith("admin_") || data.startsWith("lead_status_") ||
          data.startsWith("lead_to_partner_") || data.startsWith("toggle_") ||
          data.startsWith("partner_leads_admin_")) {
        await handleAdminCallback(b, update.callback_query);
      } else {
        await handleCallback(b, update.callback_query);
      }
    }
  } catch (err) {
    logger.error({ err }, "Error handling webhook update");
  }
}
