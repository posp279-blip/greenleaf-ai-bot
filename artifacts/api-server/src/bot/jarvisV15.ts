import TelegramBot from "node-telegram-bot-api";
import type { CallbackQuery, Message } from "node-telegram-bot-api";
import {
  handleJarvisV14Message,
  handleJarvisV14Callback,
  initJarvisV14,
  resolveJarvisPersonalSite,
} from "./jarvisV14.js";

const SITE_URL = process.env.JARVIS_SITE_URL || "https://greenleaf-podbor.ru";

export async function initJarvisV15(): Promise<void> {
  await initJarvisV14();
}

export async function handleJarvisV15Message(bot: TelegramBot, msg: Message): Promise<void> {
  const userId = msg.from?.id;
  const text = msg.text?.trim() || "";

  if (userId && /^\/site(?:@\w+)?$/i.test(text)) {
    const site = await resolveJarvisPersonalSite(userId);
    if (site) {
      await bot.sendMessage(
        msg.chat.id,
        `✅ Персональный сайт связан с Джарвисом.\n\nТвоя страница: ${site.url}\n\nКогда это будет уместно в разговоре с кандидатом или клиентом, Джарвис сможет предложить именно твою страницу, а не общий сайт.`,
        {
          reply_markup: {
            inline_keyboard: [[{ text: "🌐 Открыть мою персональную страницу →", url: site.url }]],
          },
        },
      );
      return;
    }

    await bot.sendMessage(
      msg.chat.id,
      "Персональная страница пока не связана с Джарвисом.\n\nЕсли сайт у тебя уже есть, открой кабинет Greenleaf Select и подключи Telegram в блоке уведомлений. После этого Джарвис распознает твою страницу автоматически по Telegram ID.\n\nПока персональная связь не найдена, в подходящих ситуациях я буду использовать общий сайт.",
      {
        reply_markup: {
          inline_keyboard: [[{ text: "⚙️ Открыть кабинет сайта →", url: `${SITE_URL.replace(/\/$/, "")}/partner` }]],
        },
      },
    );
    return;
  }

  await handleJarvisV14Message(bot, msg);
}

export async function handleJarvisV15Callback(bot: TelegramBot, query: CallbackQuery): Promise<void> {
  await handleJarvisV14Callback(bot, query);
}
