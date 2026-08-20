import TelegramBot from "node-telegram-bot-api";
import type { CallbackQuery, Message } from "node-telegram-bot-api";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger.js";
import {
  handleJarvisV5Message,
  handleJarvisV5Callback,
  initJarvisV5,
} from "./jarvisV5.js";

const INTERNAL_SOURCE_RE = /\s*[\[(]?\s*SOURCE(?:\s*[:#_-]?\s*[A-Za-z0-9А-Яа-яЁё.:/_-]+)?\s*[\])]?/giu;
type SendMessageArgs = Parameters<TelegramBot["sendMessage"]>;

export function sanitizeJarvisUserText(text: string): string {
  const sanitized = text
    .replace(INTERNAL_SOURCE_RE, "")
    .replace(/\(\s*\)/g, "")
    .replace(/[ \t]+([,.;:!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return sanitized;
}

function createSanitizingBot(bot: TelegramBot): TelegramBot {
  return new Proxy(bot, {
    get(target, property, receiver) {
      if (property === "sendMessage") {
        return async (
          chatId: SendMessageArgs[0],
          text: SendMessageArgs[1],
          options?: SendMessageArgs[2],
        ) => {
          const clean = sanitizeJarvisUserText(text);
          if (clean !== text) {
            logger.warn({ chatId }, "Jarvis v6 removed internal RAG marker from user-visible reply");
          }
          return target.sendMessage(chatId, clean, options);
        };
      }

      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as TelegramBot;
}

async function sanitizeStoredHistory(userId: number): Promise<void> {
  const result = await pool.query<{ id: string; content: string }>(
    `SELECT id::text, content
     FROM jarvis_messages
     WHERE telegram_user_id = $1
       AND role = 'assistant'
       AND content ~* 'SOURCE'`,
    [userId],
  );

  for (const row of result.rows) {
    const clean = sanitizeJarvisUserText(row.content);
    if (clean === row.content) continue;
    await pool.query(
      `UPDATE jarvis_messages SET content = $2 WHERE id = $1`,
      [row.id, clean],
    );
  }
}

export async function initJarvisV6(): Promise<void> {
  await initJarvisV5();
  logger.info("Jarvis v6 clean-output layer ready");
}

export async function handleJarvisV6Message(bot: TelegramBot, msg: Message): Promise<void> {
  const userId = msg.from?.id;
  if (userId) {
    await sanitizeStoredHistory(userId);
  }

  const safeBot = createSanitizingBot(bot);
  await handleJarvisV5Message(safeBot, msg);

  if (userId) {
    await sanitizeStoredHistory(userId);
  }
}

export async function handleJarvisV6Callback(bot: TelegramBot, query: CallbackQuery): Promise<void> {
  await handleJarvisV5Callback(createSanitizingBot(bot), query);
}
