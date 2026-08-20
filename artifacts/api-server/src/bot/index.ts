import TelegramBot from "node-telegram-bot-api";
import type { Update } from "node-telegram-bot-api";
import { logger } from "../lib/logger.js";
import { handleAdminCallback } from "./engine.js";
import { seedDatabase } from "./seed.js";
import { handleJarvisMessage, handleJarvisCallback, initJarvis } from "./jarvis.js";
import { db } from "@workspace/db";
import { appSettingsTable } from "@workspace/db";

let bot: TelegramBot | null = null;

function isAdminCallback(data: string): boolean {
  return data.startsWith("admin_") ||
    data.startsWith("lead_status_") ||
    data.startsWith("lead_to_partner_") ||
    data.startsWith("toggle_") ||
    data.startsWith("partner_leads_admin_");
}

async function configureJarvisIdentity(currentBot: TelegramBot): Promise<void> {
  try {
    await currentBot.setMyCommands([
      { command: "start", description: "Начать работу с Джарвисом" },
      { command: "help", description: "Показать примеры запросов" },
      { command: "limit", description: "Проверить бесплатный лимит" },
      { command: "reset", description: "Очистить контекст диалога" },
      { command: "name", description: "Изменить имя" },
    ]);
  } catch (err) {
    logger.warn({ err }, "Failed to configure Jarvis Telegram commands");
  }

  // Newer Telegram Bot API clients may expose these methods. They are optional so
  // deployment remains compatible with the currently pinned node-telegram-bot-api.
  const identityBot = currentBot as TelegramBot & {
    setMyName?: (name: string) => Promise<unknown>;
    setMyShortDescription?: (description: string) => Promise<unknown>;
    setMyDescription?: (description: string) => Promise<unknown>;
  };

  try {
    if (identityBot.setMyName) await identityBot.setMyName("Джарвис");
    if (identityBot.setMyShortDescription) {
      await identityBot.setMyShortDescription("Нейропомощник партнёра Greenleaf");
    }
    if (identityBot.setMyDescription) {
      await identityBot.setMyDescription(
        "Джарвис помогает разбирать переписки, возражения, первые сообщения, встречи и ситуации с партнёрами Greenleaf.",
      );
    }
  } catch (err) {
    logger.warn({ err }, "Telegram client could not update Jarvis profile text");
  }
}

export async function startBot(webhookUrl?: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    logger.warn("TELEGRAM_BOT_TOKEN not set — bot will not start");
    return;
  }

  // Keep the old application data intact, but switch all user dialogue to Jarvis.
  await seedDatabase();
  await initJarvis();

  bot = new TelegramBot(token, { polling: false, webHook: false });

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

  await configureJarvisIdentity(bot);

  if (webhookUrl) {
    try {
      await bot.setWebHook(webhookUrl);
      logger.info({ webhookUrl }, "Telegram webhook set");
    } catch (err) {
      logger.error({ err, webhookUrl }, "Failed to set webhook — falling back to polling");
    }
  }

  const webhookInfo = await bot.getWebHookInfo();
  if (!webhookInfo.url || webhookInfo.url !== webhookUrl) {
    if (webhookUrl) logger.warn("Webhook not active — falling back to polling");

    bot = new TelegramBot(token, { polling: true });

    bot.on("message", async (msg) => {
      try {
        await handleJarvisMessage(bot!, msg);
      } catch (err) {
        logger.error({ err, chatId: msg.chat.id }, "Error handling Jarvis message");
        try {
          await bot!.sendMessage(msg.chat.id, "Что-то пошло не так. Попробуй отправить сообщение ещё раз.");
        } catch {}
      }
    });

    bot.on("callback_query", async (query) => {
      try {
        const data = query.data || "";
        if (isAdminCallback(data)) {
          await handleAdminCallback(bot!, query);
        } else {
          await handleJarvisCallback(bot!, query);
        }
      } catch (err) {
        logger.error({ err }, "Error handling callback query");
      }
    });

    bot.on("polling_error", (err) => {
      logger.error({ err }, "Telegram polling error");
    });

    logger.info("Telegram Jarvis bot started in polling mode");
  } else {
    logger.info("Telegram Jarvis bot started in webhook mode");
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
      await handleJarvisMessage(b, update.message);
    } else if (update.callback_query) {
      const data = update.callback_query.data || "";
      if (isAdminCallback(data)) {
        await handleAdminCallback(b, update.callback_query);
      } else {
        await handleJarvisCallback(b, update.callback_query);
      }
    }
  } catch (err) {
    logger.error({ err }, "Error handling Jarvis webhook update");
  }
}
