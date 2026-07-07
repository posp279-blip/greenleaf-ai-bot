import TelegramBot from "node-telegram-bot-api";
import { logger } from "../lib/logger.js";
import { handleMessage, handleCallback, handleAdminCallback } from "./engine.js";
import { seedDatabase } from "./seed.js";
import { db } from "@workspace/db";
import { appSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

let bot: TelegramBot | null = null;

export async function startBot(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    logger.warn("TELEGRAM_BOT_TOKEN not set — bot will not start");
    return;
  }

  // Run DB migrations/seed
  await seedDatabase();

  // Clear any stale webhook and pending updates so old processes don't steal messages
  try {
    const clearWebhook = await fetch(`https://api.telegram.org/bot${token}/deleteWebhook?drop_pending_updates=true`);
    if (clearWebhook.ok) logger.info("Cleared Telegram webhook and pending updates");
  } catch (err) {
    logger.warn({ err }, "Failed to clear webhook — continuing anyway");
  }

  bot = new TelegramBot(token, { polling: true });

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

  logger.info("Telegram bot started successfully");
}

export function getBot(): TelegramBot | null {
  return bot;
}
