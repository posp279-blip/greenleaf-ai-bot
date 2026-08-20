import TelegramBot from "node-telegram-bot-api";
import type { CallbackQuery, Message } from "node-telegram-bot-api";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger.js";
import { handleJarvisV12Message, handleJarvisV12Callback, initJarvisV12 } from "./jarvisV12.js";
import { decideJarvisSiteCta } from "./jarvisV13.js";
import { ensureJarvisSiteIdentity, signJarvisSiteRequest } from "./jarvisSiteIdentity.js";

const SITE_URL = process.env.JARVIS_SITE_URL || "https://greenleaf-podbor.ru";
const SITE_LOOKUP_URL = process.env.JARVIS_SITE_LOOKUP_URL || `${SITE_URL.replace(/\/$/, "")}/api/integrations/jarvis/partner`;
const CTA_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const LOOKUP_TIMEOUT_MS = 3500;

type SendMessageArgs = Parameters<TelegramBot["sendMessage"]>;
type SendOptions = NonNullable<SendMessageArgs[2]>;
type CtaKind = "product" | "show_candidate" | "registration" | "company";
type CtaDecision = NonNullable<ReturnType<typeof decideJarvisSiteCta>>;
type PersonalSite = { slug: string; name: string; url: string };
type LatestAssistant = { counted: boolean };

let schemaReady = false;

const SYSTEM_COPY_RE = /^(?:🔒|Осталось\s+\d+|Остался\s+\d+|Доступно\s+\d+\s+из\s+20|Привет\s|Контекст очищен|Хорошо\. Как мне|Сначала напиши|Напиши только имя|Сейчас не получилось|Что-то пошло не так)/iu;

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

async function latestAssistantCounted(userId: number): Promise<boolean> {
  const result = await pool.query<LatestAssistant>(
    `SELECT counted FROM jarvis_messages
     WHERE telegram_user_id=$1 AND role='assistant'
     ORDER BY id DESC LIMIT 1`,
    [userId],
  );
  return result.rows[0]?.counted === true;
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

function trackedUrl(baseUrl: string, kind: CtaKind, personal: boolean): string {
  try {
    const url = new URL(baseUrl);
    url.searchParams.set("utm_source", "jarvis");
    url.searchParams.set("utm_medium", "telegram_bot");
    url.searchParams.set("utm_campaign", personal ? "personal_partner_site" : "smart_site_cta");
    url.searchParams.set("utm_content", kind);
    return url.toString();
  } catch {
    return baseUrl;
  }
}

function personalCopy(kind: CtaKind): { buttonText: string; bridge: string } {
  if (kind === "product") {
    return {
      buttonText: "🌿 Открыть мою страницу с продукцией →",
      bridge: "🌿 У тебя уже подключён персональный сайт. Здесь проще отправить человеку одну ссылку на свою страницу, чем пересылать карточки и материалы вручную.",
    };
  }
  if (kind === "registration") {
    return {
      buttonText: "✅ Открыть мою персональную страницу →",
      bridge: "✅ Раз человек готов двигаться дальше, используй свою персональную страницу как следующий шаг — так он не потеряется между разговором и действием.",
    };
  }
  if (kind === "company") {
    return {
      buttonText: "🌐 Открыть мою страницу для кандидата →",
      bridge: "🌐 Здесь удобно использовать твою персональную страницу: дай человеку одну ссылку и возможность спокойно посмотреть Greenleaf самостоятельно.",
    };
  }
  return {
    buttonText: "🌐 Открыть мою страницу для кандидата →",
    bridge: "💡 Здесь как раз пригодится твоя персональная страница: вместо десятка сообщений можно дать человеку одну ссылку и спокойно продолжить разговор после просмотра.",
  };
}

function addBridge(text: string, bridge: string): string {
  if (/greenleaf-podbor|сайт-каталог|персональн(?:ый|ая|ую)\s+(?:сайт|страниц)/iu.test(text)) return text;
  return `${text.trim()}\n\n${bridge}`;
}

function withButton(options: SendOptions | undefined, text: string, url: string): SendOptions {
  const base = (options ? { ...options } : {}) as SendOptions & { reply_markup?: any };
  base.reply_markup = {
    ...(base.reply_markup || {}),
    inline_keyboard: [[{ text, url }]],
  };
  return base;
}

export async function resolveJarvisPersonalSite(userId: number): Promise<PersonalSite | null> {
  if (!Number.isSafeInteger(userId) || userId <= 0) return null;

  const body = JSON.stringify({ telegramUserId: String(userId) });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await signJarvisSiteRequest(`${timestamp}.${body}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);

  try {
    const response = await fetch(SITE_LOOKUP_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Jarvis-Timestamp": timestamp,
        "X-Jarvis-Signature": signature,
      },
      body,
    });
    if (!response.ok) {
      logger.warn({ userId, status: response.status }, "Jarvis v14 personal site lookup rejected");
      return null;
    }

    const payload = await response.json() as { found?: boolean; slug?: string; name?: string };
    const slug = String(payload.slug || "").trim();
    if (!payload.found || !/^[a-z0-9-]{1,40}$/.test(slug)) return null;

    const url = new URL(`/p/${encodeURIComponent(slug)}`, SITE_URL).toString();
    return {
      slug,
      name: String(payload.name || "").trim().slice(0, 80),
      url,
    };
  } catch (err) {
    logger.warn({ err, userId }, "Jarvis v14 personal site lookup failed; generic CTA will be used");
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function withPersonalSiteCta(bot: TelegramBot, userId: number, userText: string): TelegramBot {
  let handled = false;
  return new Proxy(bot, {
    get(target, property, receiver) {
      if (property === "sendMessage") {
        return async (...args: SendMessageArgs) => {
          const [chatId, text, options] = args;
          if (handled || SYSTEM_COPY_RE.test(text)) return target.sendMessage(chatId, text, options);

          const decision = decideJarvisSiteCta(userText, text);
          if (!decision) return target.sendMessage(chatId, text, options);
          if (!(await latestAssistantCounted(userId))) return target.sendMessage(chatId, text, options);
          if (!(await canShowCta(userId))) return target.sendMessage(chatId, text, options);
          if (options?.reply_markup) return target.sendMessage(chatId, text, options);

          const personalSite = await resolveJarvisPersonalSite(userId);
          const kind = decision.kind as CtaKind;
          const copy = personalSite ? personalCopy(kind) : { buttonText: decision.buttonText, bridge: decision.bridge };
          const destination = personalSite ? personalSite.url : SITE_URL;
          const finalText = addBridge(text, copy.bridge);
          const nextOptions = withButton(options, copy.buttonText, trackedUrl(destination, kind, Boolean(personalSite)));

          handled = true;
          const sent = await target.sendMessage(chatId, finalText, nextOptions);
          await rememberCta(userId, kind);
          logger.info(
            { userId, kind, personalized: Boolean(personalSite), slug: personalSite?.slug || null },
            "Jarvis v14 contextual website CTA shown",
          );
          return sent;
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as TelegramBot;
}

export async function initJarvisV14(): Promise<void> {
  await initJarvisV12();
  await ensureSchema();
  await ensureJarvisSiteIdentity();
  logger.info("Jarvis v14 personal partner-site linking ready");
}

export async function handleJarvisV14Message(bot: TelegramBot, msg: Message): Promise<void> {
  const userId = msg.from?.id;
  if (!userId) return handleJarvisV12Message(bot, msg);
  const userText = msg.text?.trim() || "";
  await handleJarvisV12Message(withPersonalSiteCta(bot, userId, userText), msg);
}

export async function handleJarvisV14Callback(bot: TelegramBot, query: CallbackQuery): Promise<void> {
  await handleJarvisV12Callback(bot, query);
}
