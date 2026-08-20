import TelegramBot from "node-telegram-bot-api";
import type { CallbackQuery, Message } from "node-telegram-bot-api";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger.js";
import { handleJarvisV12Message, handleJarvisV12Callback, initJarvisV12 } from "./jarvisV12.js";

const SITE_URL = process.env.JARVIS_SITE_URL || "https://greenleaf-podbor.ru";
const CTA_COOLDOWN_MS = 6 * 60 * 60 * 1000;

type SendMessageArgs = Parameters<TelegramBot["sendMessage"]>;
type SendOptions = NonNullable<SendMessageArgs[2]>;
type CtaKind = "product" | "show_candidate" | "registration" | "company";
type CtaDecision = { kind: CtaKind; buttonText: string; bridge: string } | null;
type LatestAssistant = { counted: boolean };

let schemaReady = false;

const SYSTEM_COPY_RE = /^(?:🔒|Осталось\s+\d+|Остался\s+\d+|Доступно\s+\d+\s+из\s+20|Привет\s|Контекст очищен|Хорошо\. Как мне|Сначала напиши|Напиши только имя|Сейчас не получилось|Что-то пошло не так)/iu;
const PRODUCT_RE = /(?:продукц|товар|средств|каталог|подборк|что\s+посоветовать|что\s+подобрать|цены?\s+на\s+(?:продукц|товар)|ассортимент)/iu;
const SEND_SHOW_RE = /(?:что\s+(?:ему|ей|человеку|кандидату)\s+(?:отправить|скинуть|показать|дать)|что\s+(?:отправить|скинуть|показать)|после\s+(?:разговора|встречи|презентации).{0,80}(?:отправ|дать|показ)|пусть\s+(?:сам|сама)\s+посмотр|самостоятельно\s+(?:посмотр|ознаком)|одной\s+ссылк|где\s+(?:ему|ей|человеку|кандидату)?\s*посмотреть)/iu;
const REGISTRATION_RE = /(?:регистрац|зарегистрир|оформить\s+партн|стать\s+партн|готов\s+регистр|куда\s+вести\s+на\s+регистрац)/iu;
const COMPANY_RE = /(?:что\s+такое\s+greenleaf|о\s+компании|про\s+компани|показать\s+компани|как\s+показать\s+greenleaf|возможност(?:и|ях)\s+greenleaf)/iu;
const PERSON_RE = /(?:кандидат|человек|знаком|клиент|нович|ему|ей)/iu;
const OBJECTION_ONLY_RE = /(?:пирамид|дорого|нет\s+времени|надо\s+подумать|неинтерес|не\s+интерес)/iu;

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
  if (!user || user.startsWith("/") || answerText.length < 80 || SYSTEM_COPY_RE.test(answerText)) return null;

  // Возражение само по себе не повод уводить человека на сайт — сначала надо нормально разобрать возражение.
  if (OBJECTION_ONLY_RE.test(user) && !SEND_SHOW_RE.test(user) && !REGISTRATION_RE.test(user)) return null;

  if (REGISTRATION_RE.test(user)) {
    return {
      kind: "registration",
      buttonText: "✅ Посмотреть путь на сайте →",
      bridge: "✅ Когда человек готов идти дальше, персональная страница помогает не потерять его между разговором и следующим шагом. Ниже можно посмотреть, как это устроено.",
    };
  }

  if (PRODUCT_RE.test(user) && (PERSON_RE.test(user) || SEND_SHOW_RE.test(user))) {
    return {
      kind: "product",
      buttonText: "🌿 Посмотреть подбор на сайте →",
      bridge: "🌿 В такой ситуации удобно подключить сайт-каталог: продукцию и подборку проще показать одной страницей, чем пересылать карточки вручную.",
    };
  }

  if (SEND_SHOW_RE.test(user)) {
    return {
      kind: "show_candidate",
      buttonText: "🌐 Посмотреть персональную страницу →",
      bridge: "💡 Здесь как раз полезен персональный сайт: вместо десятка материалов кандидат получает одну страницу, где может спокойно всё посмотреть сам. Ниже можно посмотреть, как это работает.",
    };
  }

  if (COMPANY_RE.test(user) && PERSON_RE.test(user)) {
    return {
      kind: "company",
      buttonText: "🌐 Посмотреть, как работает сайт →",
      bridge: "🌐 Если человеку удобнее сначала посмотреть всё самостоятельно, персональная страница хорошо продолжает разговор — без длинной переписки и лишнего давления.",
    };
  }

  return null;
}

function trackedUrl(kind: CtaKind): string {
  try {
    const url = new URL(SITE_URL);
    url.searchParams.set("utm_source", "jarvis");
    url.searchParams.set("utm_medium", "telegram_bot");
    url.searchParams.set("utm_campaign", "smart_site_cta");
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

async function latestAssistantCounted(userId: number): Promise<boolean> {
  const result = await pool.query<LatestAssistant>(
    `SELECT counted FROM jarvis_messages
     WHERE telegram_user_id=$1 AND role='assistant'
     ORDER BY id DESC LIMIT 1`,
    [userId],
  );
  return result.rows[0]?.counted === true;
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

function addBridge(text: string, bridge: string): string {
  if (/greenleaf-podbor|сайт-каталог|персональн(?:ый|ая)\s+(?:сайт|страниц)/iu.test(text)) return text;
  return `${text.trim()}\n\n${bridge}`;
}

function withSiteButton(options: SendOptions | undefined, decision: NonNullable<CtaDecision>): SendOptions {
  const base = (options ? { ...options } : {}) as SendOptions & { reply_markup?: any };
  const existingRows: any[][] = base.reply_markup && Array.isArray(base.reply_markup.inline_keyboard)
    ? base.reply_markup.inline_keyboard
    : [];

  base.reply_markup = {
    ...(base.reply_markup || {}),
    inline_keyboard: [
      ...existingRows,
      [{ text: decision.buttonText, url: trackedUrl(decision.kind) }],
    ],
  };
  return base;
}

function withSiteCta(bot: TelegramBot, userId: number, userText: string): TelegramBot {
  let handled = false;
  return new Proxy(bot, {
    get(target, property, receiver) {
      if (property === "sendMessage") {
        return async (...args: SendMessageArgs) => {
          const [chatId, text, options] = args;
          if (handled || SYSTEM_COPY_RE.test(text)) return target.sendMessage(chatId, text, options);

          const decision = decideJarvisSiteCta(userText, text);
          if (!decision) return target.sendMessage(chatId, text, options);

          // CTA показывается только после полноценного ответа, а не после бесплатного наводящего вопроса.
          if (!(await latestAssistantCounted(userId))) return target.sendMessage(chatId, text, options);
          if (!(await canShowCta(userId))) return target.sendMessage(chatId, text, options);

          // Не смешиваем CTA сайта с уже существующей технической кнопкой (например, блокировкой в Greenleaf Coach).
          if (options?.reply_markup) return target.sendMessage(chatId, text, options);

          handled = true;
          const finalText = addBridge(text, decision.bridge);
          const nextOptions = withSiteButton(options, decision);
          const sent = await target.sendMessage(chatId, finalText, nextOptions);
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
