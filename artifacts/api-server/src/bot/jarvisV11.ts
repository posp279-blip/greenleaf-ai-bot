import TelegramBot from "node-telegram-bot-api";
import type { CallbackQuery, Message } from "node-telegram-bot-api";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger.js";
import { handleJarvisV10Message, handleJarvisV10Callback, initJarvisV10 } from "./jarvisV10.js";

const COLD_CONTEXT_RE = /(?:лично\s+не\s+знаком|вообще\s+не\s+знаком|не\s+знакомы).*(?:комментар|групп)|(?:комментар|групп).*(?:лично\s+не\s+знаком|вообще\s+не\s+знаком|не\s+знакомы)/iu;
const COLD_FIRST_CONTEXT_RE = /(?:холодн|первое\s+сообщен|наблюдател)/iu;
const LOCK_OR_SYSTEM_RE = /^(?:🔒|Осталось\s+\d+|Остался\s+\d+|Доступно\s+\d+|Привет\s*👋|Контекст очищен|Сейчас не получилось|Что-то пошло не так)/iu;
const READY_QUOTE_RE = /(?:«[^»]{18,}»|"[^"\n]{18,}")/u;

type SendMessageArgs = Parameters<TelegramBot["sendMessage"]>;
type RecentMessage = { role: string; content: string };

async function recentHistory(userId: number, limit = 10): Promise<RecentMessage[]> {
  const result = await pool.query<RecentMessage>(
    `SELECT role, content FROM (
       SELECT id, role, content
       FROM jarvis_messages
       WHERE telegram_user_id = $1 AND role IN ('user','assistant')
       ORDER BY id DESC LIMIT $2
     ) q ORDER BY id ASC`,
    [userId, limit],
  );
  return result.rows;
}

function coldContextIsSufficient(history: RecentMessage[], current: string): boolean {
  if (!COLD_CONTEXT_RE.test(current)) return false;
  return history.some((item) => item.role === "user" && COLD_FIRST_CONTEXT_RE.test(item.content));
}

function rememberedPersonName(history: RecentMessage[]): string | null {
  const joined = history.filter((item) => item.role === "user").map((item) => item.content).join("\n");
  const patterns = [
    /(?:кандидат(?:а)?\s+зовут|е[её]\s+зовут|его\s+зовут)\s+([А-ЯЁ][а-яё]{2,24})/iu,
    /([А-ЯЁ][а-яё]{2,24})\s+[-—]\s+(?:кандидат|партн[её]р|бывш)/iu,
  ];
  for (const pattern of patterns) {
    const match = joined.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

function refersToKnownPerson(current: string): boolean {
  return /(?:^|[\s«"(])(?:она|он|ей|ему|её|его)(?=$|[\s,.:;!?»")])/iu.test(current);
}

function containsName(text: string, name: string): boolean {
  return text.toLocaleLowerCase("ru-RU").includes(name.toLocaleLowerCase("ru-RU"));
}

function memoryFallback(name: string): string {
  return `Здесь ${name} не говорит «нет» — она говорит, что сейчас не готова платить такую сумму. Я бы не убеждал и не доказывал ценность наугад.\n\nНапиши так:\n\n«${name}, понимаю. Скажи, тебя сейчас останавливает сама сумма или ты пока не видишь, за счёт чего такой старт имеет смысл?»\n\nПо её ответу уже будет понятно, что разбирать дальше. Пришли ответ сюда — продолжим.`;
}

function coldFallback(): string {
  return `Лично вы не знакомы, поэтому здесь не нужен резкий заход в Greenleaf. Лучше опереться на реальный повод — его комментарий в группе — и сначала открыть обычный диалог.\n\nЯ бы написал так:\n\n«Привет! Увидел твой комментарий в группе — зацепила мысль, которую ты написал. Решил познакомиться 🙂 Как ты сам пришёл к такому взгляду?»\n\nНе презентуй Greenleaf в первом сообщении. Сначала дождись нормального ответа и продолжи разговор по теме комментария.`;
}

function wrapRegressionGuards(
  bot: TelegramBot,
  currentText: string,
  name: string | null,
  enoughCold: boolean,
): TelegramBot {
  let firstSubstantiveHandled = false;
  return new Proxy(bot, {
    get(target, property, receiver) {
      if (property === "sendMessage") {
        return async (...args: SendMessageArgs) => {
          const [chatId, text, options] = args;
          let finalText = text;
          const system = LOCK_OR_SYSTEM_RE.test(text);

          if (!system && !firstSubstantiveHandled) {
            firstSubstantiveHandled = true;
            if (enoughCold && !READY_QUOTE_RE.test(text)) {
              finalText = coldFallback();
              logger.info("Jarvis v11 normalized sufficient cold-context reply to ready message");
            } else if (
              name &&
              refersToKnownPerson(currentText) &&
              !containsName(text, name)
            ) {
              finalText = memoryFallback(name);
              logger.info({ name }, "Jarvis v11 restored remembered person context");
            }
          }

          return target.sendMessage(chatId, finalText, options);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as TelegramBot;
}

async function restoreLatestUserMessage(userId: number, original: string): Promise<void> {
  await pool.query(
    `UPDATE jarvis_messages
     SET content = $2
     WHERE id = (
       SELECT id FROM jarvis_messages
       WHERE telegram_user_id = $1 AND role = 'user'
       ORDER BY id DESC LIMIT 1
     )`,
    [userId, original],
  );
}

export async function initJarvisV11(): Promise<void> {
  await initJarvisV10();
  logger.info("Jarvis v11 cold-context + memory regression guard ready");
}

export async function handleJarvisV11Message(bot: TelegramBot, msg: Message): Promise<void> {
  const userId = msg.from?.id;
  const originalText = msg.text?.trim() || "";
  if (!userId || !originalText || originalText.startsWith("/")) {
    await handleJarvisV10Message(bot, msg);
    return;
  }

  const history = await recentHistory(userId, 10);
  const rememberedName = rememberedPersonName(history);
  const enoughCold = coldContextIsSufficient(history, originalText);
  const effectiveText = enoughCold
    ? `${originalText}\n\nКонтекста уже достаточно. Не задавай дополнительных уточняющих вопросов. Дай готовое первое сообщение, которое можно отправить как есть.`
    : originalText;

  const effectiveMsg = effectiveText === originalText ? msg : ({ ...msg, text: effectiveText } as Message);
  const guardedBot = wrapRegressionGuards(bot, originalText, rememberedName, enoughCold);

  await handleJarvisV10Message(guardedBot, effectiveMsg);

  if (effectiveText !== originalText) {
    await restoreLatestUserMessage(userId, originalText);
    logger.info("Jarvis v11 used sufficient cold-context directive and restored original history text");
  }
}

export async function handleJarvisV11Callback(bot: TelegramBot, query: CallbackQuery): Promise<void> {
  await handleJarvisV10Callback(bot, query);
}
