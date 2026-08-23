import TelegramBot from "node-telegram-bot-api";
import type { CallbackQuery, Message } from "node-telegram-bot-api";
import { logger } from "../lib/logger.js";
import {
  handleJarvisV15Message,
  handleJarvisV15Callback,
  initJarvisV15,
} from "./jarvisV15.js";

const TYPING_INTERVAL_MS = 4_000;
const SLOW_NOTICE_MS = 12_000;
const activeUsers = new Set<number>();

function isFastCommand(text: string): boolean {
  return /^\/(?:site|limit|help)(?:@\w+)?$/iu.test(text);
}

export async function initJarvisV16(): Promise<void> {
  await initJarvisV15();
  logger.info("Jarvis v16 latency + per-user concurrency guard ready");
}

export async function handleJarvisV16Message(bot: TelegramBot, msg: Message): Promise<void> {
  const userId = msg.from?.id;
  const text = msg.text?.trim() || "";

  if (!userId || !text || isFastCommand(text)) {
    await handleJarvisV15Message(bot, msg);
    return;
  }

  if (activeUsers.has(userId)) {
    try {
      await bot.sendMessage(
        msg.chat.id,
        "Я ещё разбираю предыдущее сообщение. Дождись ответа — новый разбор сейчас не запускаю, чтобы не смешивать контекст.",
      );
    } catch {}
    logger.info({ userId }, "Jarvis v16 blocked overlapping user request");
    return;
  }

  activeUsers.add(userId);
  const startedAt = Date.now();
  let finished = false;
  let slowNoticeSent = false;

  try {
    try { await bot.sendChatAction(msg.chat.id, "typing"); } catch {}

    const typingTimer = setInterval(() => {
      if (finished) return;
      void bot.sendChatAction(msg.chat.id, "typing").catch(() => undefined);
    }, TYPING_INTERVAL_MS);

    const slowTimer = setTimeout(() => {
      if (finished || slowNoticeSent) return;
      slowNoticeSent = true;
      void bot.sendMessage(
        msg.chat.id,
        "Разбор занимает чуть больше времени — я продолжаю. Ответ не потерялся 👍",
      ).catch(() => undefined);
    }, SLOW_NOTICE_MS);

    try {
      await handleJarvisV15Message(bot, msg);
    } finally {
      finished = true;
      clearInterval(typingTimer);
      clearTimeout(slowTimer);
    }
  } finally {
    activeUsers.delete(userId);
    const durationMs = Date.now() - startedAt;
    if (durationMs >= SLOW_NOTICE_MS) {
      logger.info({ userId, durationMs }, "Jarvis v16 slow request completed");
    }
  }
}

export async function handleJarvisV16Callback(bot: TelegramBot, query: CallbackQuery): Promise<void> {
  await handleJarvisV15Callback(bot, query);
}
