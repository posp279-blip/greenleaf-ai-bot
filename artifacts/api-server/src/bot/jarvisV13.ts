import TelegramBot from "node-telegram-bot-api";
import type { CallbackQuery, Message } from "node-telegram-bot-api";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger.js";
import { handleJarvisV12Message, handleJarvisV12Callback, initJarvisV12 } from "./jarvisV12.js";

const SITE_URL = process.env.JARVIS_SITE_URL || "https://greenleaf-podbor.ru";
const CTA_COOLDOWN_MS = 6 * 60 * 60 * 1000;

type SendMessageArgs = Parameters<TelegramBot["sendMessage"]>;
type CtaKind = "product" | "show_candidate" | "registration" | "company";
type CtaDecision = { kind: CtaKind; buttonText: string } | null;

let schemaReady = false;

const SYSTEM_COPY_RE = /^(?:🔒|Осталось\s+\d+|Остался\s+\d+|Доступно\s+\d+\s+из\s+20|Привет\s|Контекст очищен|Хорошо\. Как мне|Сначала напиши|Напиши только имя|Сейчас не получилось|Что-то пошло не так)/iu;
const PRODUCT_RE = /(?:продукц|товар|средств|каталог|подборк|что\s+посоветовать|что\s+подобрать|цена|стоимост|уход|стирк|кухн|гигиен)/iu;
const SEND_SHOW_RE = /(?:что\s+(?:ему|ей|человеку|кандидату)\s+(?:отправить|скинуть|показать)|что\s+отправить|что\s+скинуть|что\s+показать|после\s+(?:разговора|встречи|презентации)|пусть\s+(?:сам|сама)\s+посмотр|самостоятельно\s+(?:посмотр|ознаком)|одной\s+ссылк|персональн(?:ая|ую)\s+страниц)/iu;
const REGISTRATION_RE = /(?:регистрац|зарегистрир|оформить\s+партн|стать\s+партн|готов\s+регистр)/iu;
const COMPANY_RE = /(?:что\s+такое\s+greenleaf|о\s+компании|про\s+компани|возможност|доход|бизнес|партн[её]рств)/iu;
const PERSON_RE = /(?:кандидат|человек|знаком|клиент|нович|он\s|она\s|ему|ей)/iu;

async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS jarvis_site_cta_events (
      telegram_user_id BIGINT PRIMARY KEY,
      last_kind TEXT NOT NULL,
      last_shown_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  schemaReady = true;
}

export function decideJarvisSiteCta(userText: string, answerText: string): CtaDecision {
  const user = userText.trim();
  const combined = `${user}\n${answerText}`;

  if (!user || user.startsWith("/") || answerText.length < 80 || SYSTEM_COPY_RE.test(answerText)) return null;

  if (REGISTRATION_RE.test(combined)) {
    return { kind: "registration", buttonText: "📝 Перейти к регистрации на сайте →" };
  }

  if (PRODUCT_RE.test(combined) && (PERSON_RE.test(combined) || SEND_SHOW_RE.test(combined))) {
    return { kind: "product", buttonText: "🌿 Подобрать продукцию на сайте →" };
  }

  if (SEND_SHOW_RE.test(combined)) {
    return { kind: "show_candidate", buttonText: "🌐 Показать сайт кандидату →" };
  }

  if (COMPANY_RE.test(combined) && PERSON_RE.test(combined)) {
    return { kind: "company", buttonText: "🌐 Дать человеку посмотреть сайт →" };
  }

  return null;
}

function trackedUrl(kind: CtaKind): string {
  try {
    const url = new URL(SITE_URL);
    url.searchParams.set("utm_source", "jarvis");
    url.searchParams.set("utm_medium", "telegram_bot");
    url.searchParams.set("utm_campaign", "smart_cta");
    url.searchParams.set("utm_content", kind);
    return url.toString();
  } catch {
    return SITE_URL;
  }
}

async function canShowCta(userId: number): Promise<boolean> {
  await ensureSchema();
  const result = await pool.query<{ last_shown_at: Date }>(
    "SELECT last_shown_at FROM jarvis_site_cta_events WHERE telegram_user_id=$1",
    [userId],
  );
  const last = result.rows[0]?.last_shown_at ? new Date(result.rows[0].last_shown_at) : null;
  return !last || Date.now() - last.getTime() >= CTA_COOLDOWN_MS;
}

async function rememberCta(userId: number, kind: CtaKind): Promise<void> {
  await ensureSchema();
  await pool.query(
    `INSERT INTO jarvis_site_cta_events (telegram_user_id, last_kind, last_shown_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (telegram_user_id)
     DO UPDATE SET last_kind=EXCLUDED.last_kind, last_shown_at=NOW()`,
    [userId, kind],
  );
}

function withSiteCta(bot: TelegramBot, userId: number, userText: string): TelegramBot {
  let handled = false;
  return new Proxy(bot, {
    get(target, property, receiver) {
      if (property === "sendMessage") {
        return async (...args: SendMessageArgs) => {
          const [chatId, text, options] = args;
          if (handled || options?.reply_markup) return target.sendMessage(chatId, text, options);

          const decision = decideJarvisSiteCta(userText, text);
          if (!decision || !(await canShowCta(userId))) return target.sendMessage(chatId, text, options);

          handled = true;
          const nextOptions = {
            ...(options || {}),
            reply_markup: {
              inline_keyboard: [[{ text: decision.buttonText, url: trackedUrl(decision.kind) }]],
            },
          };
          const sent = await target.sendMessage(chatId, text, nextOptions);
          await rememberCta(userId, decision.kind);
          logger.info({ userId, kind: decision.kind }, "Jarvis v13 contextual website CTA shown");
          return sent;
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as TelegramBot;
}

export async function initJarvisV13(): Promise<void> {
  await initJarvisV12();
  await ensureSchema();
  logger.info("Jarvis v13 contextual website CTA layer ready");
}

export async function handleJarvisV13Message(bot: TelegramBot, msg: Message): Promise<void> {
  const userId = msg.from?.id;
  if (!userId) return handleJarvisV12Message(bot, msg);
  const userText = msg.text?.trim() || "";
  await handleJarvisV12Message(withSiteCta(bot, userId, userText), msg);
}

export async function handleJarvisV13Callback(bot: TelegramBot, query: CallbackQuery): Promise<void> {
  await handleJarvisV12Callback(bot, query);
}
