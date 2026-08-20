import TelegramBot from "node-telegram-bot-api";
import type { CallbackQuery, Message, SendMessageOptions } from "node-telegram-bot-api";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger.js";
import { handleJarvisV11Message, handleJarvisV11Callback, initJarvisV11 } from "./jarvisV11.js";

const LIMIT = 20;
const COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const APP_URL = process.env.JARVIS_APP_URL || "https://greenleaf-coach.replit.app";
const TIME_ZONE = process.env.JARVIS_TIME_ZONE || "Europe/Moscow";

type SendMessageArgs = Parameters<TelegramBot["sendMessage"]>;
type QuotaRow = {
  answers_used: number;
  window_started_at: Date | null;
  locked_until: Date | null;
  cooldown_started_at: Date | null;
};

type QuotaStatus = {
  used: number;
  remaining: number;
  locked: boolean;
  lockedUntil: Date | null;
};

let schemaReady = false;

async function ensureV12Schema(): Promise<void> {
  if (schemaReady) return;
  await pool.query(`ALTER TABLE jarvis_usage ADD COLUMN IF NOT EXISTS cooldown_started_at TIMESTAMPTZ`);
  schemaReady = true;
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: TIME_ZONE,
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

async function preferredName(userId: number): Promise<string> {
  const result = await pool.query<{ preferred_name: string | null }>(
    "SELECT preferred_name FROM jarvis_profiles WHERE telegram_user_id=$1",
    [userId],
  );
  return result.rows[0]?.preferred_name || "друг";
}

async function normalizeQuota(userId: number): Promise<QuotaStatus> {
  await ensureV12Schema();
  const cx = await pool.connect();
  try {
    await cx.query("BEGIN");
    await cx.query(
      "INSERT INTO jarvis_usage (telegram_user_id) VALUES ($1) ON CONFLICT (telegram_user_id) DO NOTHING",
      [userId],
    );
    const selected = await cx.query<QuotaRow>(
      `SELECT answers_used, window_started_at, locked_until, cooldown_started_at
       FROM jarvis_usage WHERE telegram_user_id=$1 FOR UPDATE`,
      [userId],
    );
    const row = selected.rows[0];
    const now = new Date();
    let used = Number(row?.answers_used || 0);
    let lockedUntil = row?.locked_until ? new Date(row.locked_until) : null;
    let cooldownStarted = row?.cooldown_started_at ? new Date(row.cooldown_started_at) : null;

    if (used < LIMIT) {
      if (row?.window_started_at || row?.locked_until || row?.cooldown_started_at) {
        await cx.query(
          `UPDATE jarvis_usage
           SET window_started_at=NULL, locked_until=NULL, cooldown_started_at=NULL, updated_at=NOW()
           WHERE telegram_user_id=$1`,
          [userId],
        );
      }
      await cx.query("COMMIT");
      return { used, remaining: LIMIT - used, locked: false, lockedUntil: null };
    }

    if (!cooldownStarted) {
      cooldownStarted = now;
      lockedUntil = new Date(now.getTime() + COOLDOWN_MS);
      await cx.query(
        `UPDATE jarvis_usage
         SET answers_used=$2, window_started_at=$3, cooldown_started_at=$3, locked_until=$4, updated_at=NOW()
         WHERE telegram_user_id=$1`,
        [userId, LIMIT, cooldownStarted, lockedUntil],
      );
      used = LIMIT;
    }

    if (!lockedUntil) {
      lockedUntil = new Date(cooldownStarted.getTime() + COOLDOWN_MS);
      await cx.query(
        `UPDATE jarvis_usage SET locked_until=$2, window_started_at=$3, updated_at=NOW()
         WHERE telegram_user_id=$1`,
        [userId, lockedUntil, cooldownStarted],
      );
    }

    if (lockedUntil.getTime() <= now.getTime()) {
      await cx.query(
        `UPDATE jarvis_usage
         SET answers_used=0, window_started_at=NULL, locked_until=NULL, cooldown_started_at=NULL, updated_at=NOW()
         WHERE telegram_user_id=$1`,
        [userId],
      );
      await cx.query("COMMIT");
      return { used: 0, remaining: LIMIT, locked: false, lockedUntil: null };
    }

    await cx.query("COMMIT");
    return { used: LIMIT, remaining: 0, locked: true, lockedUntil };
  } catch (err) {
    await cx.query("ROLLBACK");
    throw err;
  } finally {
    cx.release();
  }
}

async function lockedText(userId: number, until: Date | null): Promise<string> {
  const name = await preferredName(userId);
  const date = until || new Date(Date.now() + COOLDOWN_MS);
  return `🔒 ${name}, бесплатные 20 полноценных ответов Джарвиса закончились.\n\nСледующие 20 ответов станут доступны ${formatDate(date)}.\n\nНе хочешь ждать? Переходи в Greenleaf Coach и работай на полную катушку — без ограничений.`;
}

function lockedOptions(): SendMessageOptions {
  return {
    reply_markup: {
      inline_keyboard: [[{ text: "Работать без ограничений в Greenleaf Coach →", url: APP_URL }]],
    },
  };
}

async function showV12Limit(bot: TelegramBot, chatId: number, userId: number): Promise<void> {
  const status = await normalizeQuota(userId);
  if (status.locked) {
    await bot.sendMessage(chatId, await lockedText(userId, status.lockedUntil), lockedOptions());
    return;
  }
  await bot.sendMessage(
    chatId,
    `Доступно ${status.remaining} из ${LIMIT} полноценных ответов Джарвиса.\n\nЭти ответы не сгорают по времени. Когда используешь все 20, начнётся 7-дневная пауза, после которой снова будут доступны 20 из 20.\n\nНаводящие и уточняющие вопросы лимит не расходуют.`,
  );
}

function wrapQuotaCopy(bot: TelegramBot, userId: number): TelegramBot {
  return new Proxy(bot, {
    get(target, property, receiver) {
      if (property === "sendMessage") {
        return async (...args: SendMessageArgs) => {
          const [chatId, text, options] = args;

          if (/^🔒/u.test(text)) {
            const status = await normalizeQuota(userId);
            return target.sendMessage(chatId, await lockedText(userId, status.lockedUntil), lockedOptions());
          }

          if (/^Остался 1 бесплатный полноценный ответ/iu.test(text)) {
            return target.sendMessage(
              chatId,
              "Остался 1 бесплатный полноценный ответ Джарвиса. После него начнётся 7-дневная пауза, затем снова будут доступны 20 ответов.",
              options,
            );
          }

          if (/^Осталось 5 бесплатных полноценных ответов/iu.test(text)) {
            return target.sendMessage(
              chatId,
              "Осталось 5 бесплатных полноценных ответов Джарвиса. Наводящие вопросы лимит не расходуют.",
              options,
            );
          }

          return target.sendMessage(chatId, text, options);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as TelegramBot;
}

export async function initJarvisV12(): Promise<void> {
  await initJarvisV11();
  await ensureV12Schema();
  logger.info("Jarvis v12 exhaustion-based 20-answer cooldown ready");
}

export async function handleJarvisV12Message(bot: TelegramBot, msg: Message): Promise<void> {
  const userId = msg.from?.id;
  if (!userId) {
    await handleJarvisV11Message(bot, msg);
    return;
  }

  await normalizeQuota(userId);

  const text = msg.text?.trim() || "";
  if (text === "/limit") {
    await showV12Limit(bot, msg.chat.id, userId);
    return;
  }

  await handleJarvisV11Message(wrapQuotaCopy(bot, userId), msg);
}

export async function handleJarvisV12Callback(bot: TelegramBot, query: CallbackQuery): Promise<void> {
  await handleJarvisV11Callback(bot, query);
}
