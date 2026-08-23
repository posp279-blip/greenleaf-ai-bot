import OpenAI from "openai";
import TelegramBot from "node-telegram-bot-api";
import type { CallbackQuery, Message } from "node-telegram-bot-api";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger.js";
import {
  handleJarvisV16Message,
  handleJarvisV16Callback,
  initJarvisV16,
} from "./jarvisV16.js";
import { decideJarvisSiteCta } from "./jarvisV13.js";
import { resolveJarvisPersonalSite } from "./jarvisV14.js";

const LIMIT = 20;
const COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const CTA_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const APP_URL = process.env.JARVIS_APP_URL || "https://greenleaf-coach.replit.app";
const SITE_URL = process.env.JARVIS_SITE_URL || "https://greenleaf-podbor.ru";
const TIME_ZONE = process.env.JARVIS_TIME_ZONE || "Europe/Moscow";
const PROXY_BASE_URL = process.env.PROXY_API_BASE_URL || "https://api.proxyapi.ru/openai/v1";
const PROXY_MODEL = process.env.PROXY_API_MODEL || "gpt-4o-mini";
const AI_ENABLED = process.env.AI_ENABLED !== "false";
const AI_TIMEOUT_MS = Number(process.env.JARVIS_AI_TIMEOUT_MS || 28000);
const TYPING_INTERVAL_MS = 4000;
const SLOW_NOTICE_MS = 9000;

let client: OpenAI | null = null;
let schemaReady = false;
const activeUsers = new Set<number>();

type Profile = {
  preferred_name: string | null;
  memory_summary: string | null;
};

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

type FastResult = {
  response_type: "clarification" | "answer";
  text: string;
  memory_update?: string | null;
};

type KnowledgeRow = {
  id: string;
  title: string;
  heading: string;
  source_type: string;
  authority: number;
  verified: boolean;
  risk_level: string;
  content: string;
};

type RankedKnowledge = KnowledgeRow & { score: number };

type CtaKind = "product" | "show_candidate" | "registration" | "company";

type SendOptions = NonNullable<Parameters<TelegramBot["sendMessage"]>[2]>;

const INTERNAL_SOURCE_RE = /\s*[\[(]?\s*SOURCE(?:\s*[:#_-]?\s*[A-Za-z0-9А-Яа-яЁё.:/_-]+)?\s*[\])]?/giu;
const PLACEHOLDER_RE = /\[[^\]]{1,80}\]|\{[^}]{1,80}\}|<[^>]{1,80}>|\b(?:ваша\s+сфера|ваше\s+имя|имя\s+собеседника|вставьте\s+(?:сюда|имя|тему)|укажите\s+(?:имя|тему))\b/iu;
const READY_REQUEST_RE = /(?:как\s+написать|что\s+написать|напиши\s+(?:сообщение|ответ)|что\s+ответить|что\s+(?:ему|ей)\s+(?:сказать|написать)|составь\s+(?:сообщение|ответ))/iu;
const READY_QUOTE_RE = /(?:«[^»]{12,}»|"[^"\n]{12,}")/u;
const GUARANTEE_RE = /(?:гарантир(?:ован|ую|ует)|точно\s+(?:заработ|получ|поможет)|вылеч|излеч|лечит)/iu;
const STOP_WORDS = new Set([
  "это", "как", "что", "мне", "ему", "она", "они", "для", "или", "если", "есть", "уже", "просто", "только",
  "после", "перед", "теперь", "когда", "куда", "хочу", "нужно", "надо", "можно", "сейчас", "свой", "свою", "себя",
  "такой", "такое", "так", "про", "под", "над", "без", "при", "ещё", "еще", "был", "была", "будет", "быть",
]);

function ai(): OpenAI | null {
  if (!AI_ENABLED) return null;
  const key = process.env.PROXY_API_KEY || process.env.PROXY_API_TOKEN;
  if (!key) return null;
  if (!client) {
    client = new OpenAI({
      apiKey: key,
      baseURL: PROXY_BASE_URL,
      timeout: AI_TIMEOUT_MS,
      maxRetries: 0,
    });
  }
  return client;
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

function sanitize(text: string): string {
  return text
    .replace(INTERNAL_SOURCE_RE, "")
    .replace(/\(\s*\)/g, "")
    .replace(/[ \t]+([,.;:!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  await pool.query(`ALTER TABLE jarvis_usage ADD COLUMN IF NOT EXISTS cooldown_started_at TIMESTAMPTZ`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS jarvis_site_cta_events (
      telegram_user_id BIGINT PRIMARY KEY,
      last_kind TEXT NOT NULL,
      last_shown_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  schemaReady = true;
}

async function loadProfile(userId: number): Promise<Profile | null> {
  const result = await pool.query<Profile>(
    `SELECT preferred_name, memory_summary FROM jarvis_profiles WHERE telegram_user_id=$1`,
    [userId],
  );
  return result.rows[0] || null;
}

async function recentHistory(userId: number, limit = 14): Promise<Array<{ role: string; content: string }>> {
  const result = await pool.query<{ role: string; content: string }>(
    `SELECT role, content FROM (
       SELECT id, role, content FROM jarvis_messages
       WHERE telegram_user_id=$1 AND role IN ('user','assistant')
       ORDER BY id DESC LIMIT $2
     ) h ORDER BY id ASC`,
    [userId, limit],
  );
  return result.rows;
}

async function lastAssistantText(userId: number): Promise<string> {
  const result = await pool.query<{ content: string }>(
    `SELECT content FROM jarvis_messages
     WHERE telegram_user_id=$1 AND role='assistant'
     ORDER BY id DESC LIMIT 1`,
    [userId],
  );
  return result.rows[0]?.content || "";
}

async function saveMessage(
  userId: number,
  role: "user" | "assistant" | "system",
  content: string,
  messageType: string,
  counted = false,
): Promise<void> {
  await pool.query(
    `INSERT INTO jarvis_messages (telegram_user_id, role, content, message_type, counted)
     VALUES ($1,$2,$3,$4,$5)`,
    [userId, role, content, messageType, counted],
  );
}

async function saveMemory(userId: number, memory: string | null | undefined): Promise<void> {
  const value = String(memory || "").trim().slice(0, 2500);
  if (!value) return;
  await pool.query(
    `UPDATE jarvis_profiles SET memory_summary=$2, updated_at=NOW() WHERE telegram_user_id=$1`,
    [userId, value],
  );
}

function deriveLock(row: QuotaRow, now: Date): { locked: boolean; lockedUntil: Date | null; cooldownStarted: Date | null } {
  if (row.answers_used < LIMIT) return { locked: false, lockedUntil: null, cooldownStarted: null };
  const explicitUntil = row.locked_until ? new Date(row.locked_until) : null;
  const explicitStart = row.cooldown_started_at ? new Date(row.cooldown_started_at) : null;
  const cooldownStarted = explicitStart || (explicitUntil ? new Date(explicitUntil.getTime() - COOLDOWN_MS) : now);
  const lockedUntil = explicitUntil || new Date(cooldownStarted.getTime() + COOLDOWN_MS);
  return { locked: lockedUntil.getTime() > now.getTime(), lockedUntil, cooldownStarted };
}

async function normalizeQuota(userId: number): Promise<QuotaStatus> {
  await ensureSchema();
  const cx = await pool.connect();
  try {
    await cx.query("BEGIN");
    await cx.query(
      `INSERT INTO jarvis_usage (telegram_user_id) VALUES ($1)
       ON CONFLICT (telegram_user_id) DO NOTHING`,
      [userId],
    );
    const selected = await cx.query<QuotaRow>(
      `SELECT answers_used, window_started_at, locked_until, cooldown_started_at
       FROM jarvis_usage WHERE telegram_user_id=$1 FOR UPDATE`,
      [userId],
    );
    const row = selected.rows[0];
    const now = new Date();
    const used = Number(row?.answers_used || 0);

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

    const lock = deriveLock(row, now);
    if (!lock.locked) {
      await cx.query(
        `UPDATE jarvis_usage
         SET answers_used=0, window_started_at=NULL, locked_until=NULL, cooldown_started_at=NULL, updated_at=NOW()
         WHERE telegram_user_id=$1`,
        [userId],
      );
      await cx.query("COMMIT");
      return { used: 0, remaining: LIMIT, locked: false, lockedUntil: null };
    }

    await cx.query(
      `UPDATE jarvis_usage
       SET answers_used=$2, window_started_at=$3, cooldown_started_at=$3, locked_until=$4, updated_at=NOW()
       WHERE telegram_user_id=$1`,
      [userId, LIMIT, lock.cooldownStarted, lock.lockedUntil],
    );
    await cx.query("COMMIT");
    return { used: LIMIT, remaining: 0, locked: true, lockedUntil: lock.lockedUntil };
  } catch (err) {
    await cx.query("ROLLBACK");
    throw err;
  } finally {
    cx.release();
  }
}

async function reserveAnswer(userId: number): Promise<QuotaStatus & { allowed: boolean }> {
  await ensureSchema();
  const cx = await pool.connect();
  try {
    await cx.query("BEGIN");
    await cx.query(
      `INSERT INTO jarvis_usage (telegram_user_id) VALUES ($1)
       ON CONFLICT (telegram_user_id) DO NOTHING`,
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

    if (used >= LIMIT) {
      const lock = deriveLock(row, now);
      if (lock.locked) {
        await cx.query("COMMIT");
        return { used: LIMIT, remaining: 0, locked: true, lockedUntil: lock.lockedUntil, allowed: false };
      }
      used = 0;
    }

    const nextUsed = used + 1;
    const exhausted = nextUsed >= LIMIT;
    const lockedUntil = exhausted ? new Date(now.getTime() + COOLDOWN_MS) : null;
    await cx.query(
      `UPDATE jarvis_usage
       SET answers_used=$2,
           window_started_at=$3,
           cooldown_started_at=$3,
           locked_until=$4,
           updated_at=NOW()
       WHERE telegram_user_id=$1`,
      [userId, nextUsed, exhausted ? now : null, lockedUntil],
    );
    await cx.query("COMMIT");
    return {
      used: nextUsed,
      remaining: Math.max(0, LIMIT - nextUsed),
      locked: exhausted,
      lockedUntil,
      allowed: true,
    };
  } catch (err) {
    await cx.query("ROLLBACK");
    throw err;
  } finally {
    cx.release();
  }
}

function lockedOptions(): SendOptions {
  return {
    reply_markup: {
      inline_keyboard: [[{ text: "Работать без ограничений в Greenleaf Coach →", url: APP_URL }]],
    },
  };
}

async function sendLocked(bot: TelegramBot, chatId: number, userId: number, until: Date | null): Promise<void> {
  const profile = await loadProfile(userId);
  const name = profile?.preferred_name || "друг";
  const date = until || new Date(Date.now() + COOLDOWN_MS);
  await bot.sendMessage(
    chatId,
    `🔒 ${name}, бесплатные 20 полноценных ответов Джарвиса закончились.\n\nСледующие 20 ответов станут доступны ${formatDate(date)}.\n\nНе хочешь ждать? Переходи в Greenleaf Coach и работай на полную катушку — без ограничений.`,
    lockedOptions(),
  );
}

function normalizeTokens(text: string): string[] {
  const found = text.toLowerCase().replace(/ё/g, "е").match(/[a-zа-я0-9-]{3,}/giu) || [];
  return Array.from(new Set(found.filter((word) => !STOP_WORDS.has(word)))).slice(0, 24);
}

async function retrieveLocalKnowledge(userText: string, history: Array<{ role: string; content: string }>): Promise<RankedKnowledge[]> {
  const rows = await pool.query<KnowledgeRow>(
    `SELECT c.id, c.title, c.heading, c.source_type, c.authority, c.verified, c.risk_level, c.content
     FROM jarvis_knowledge_chunks c
     JOIN jarvis_knowledge_documents d ON d.id=c.document_id
     WHERE d.active=TRUE
     ORDER BY c.authority DESC, c.id ASC
     LIMIT 80`,
  );
  const queryText = `${history.slice(-6).map((item) => item.content).join(" ")} ${userText}`.toLowerCase().replace(/ё/g, "е");
  const tokens = normalizeTokens(queryText);
  const ranked = rows.rows.map((row) => {
    const title = row.title.toLowerCase().replace(/ё/g, "е");
    const heading = row.heading.toLowerCase().replace(/ё/g, "е");
    const content = row.content.toLowerCase().replace(/ё/g, "е");
    let score = row.authority / 100;
    for (const token of tokens) {
      if (title.includes(token)) score += 5;
      if (heading.includes(token)) score += 4;
      if (content.includes(token)) score += 1;
    }
    return { ...row, score };
  });
  ranked.sort((a, b) => b.score - a.score || b.authority - a.authority);
  const relevant = ranked.filter((item) => item.score > item.authority / 100 + 0.5).slice(0, 7);
  return relevant.length ? relevant : ranked.slice(0, 5);
}

function renderSources(items: RankedKnowledge[]): string {
  return items.map((item, index) => {
    const body = item.content.slice(0, 1800);
    return `SOURCE ${index + 1}\nТип: ${item.source_type}; authority=${item.authority}; verified=${item.verified}; risk=${item.risk_level}\n${item.title}\n${item.heading}\n${body}`;
  }).join("\n\n---\n\n");
}

function buildSystem(name: string, memory: string | null, sources: RankedKnowledge[]): string {
  return `Ты — Джарвис, нейропомощник партнёра Greenleaf. Отвечай как сильный практичный наставник, а не как справочник.

Пользователь: ${name}
Рабочая память: ${memory || "нет"}

Твоя задача — за ОДИН проход выдать уже финальный пользовательский ответ. Не проси внутреннюю перепроверку и не описывай свою логику.

ПРАВИЛА:
1. Для рабочих рекомендаций Greenleaf опирайся на SOURCE ниже. Приоритет — verified methodology с высоким authority.
2. Не придумывай цифры, цены, доход, сертификаты, юридические факты, медицинские свойства или гарантии. Если точного подтверждения в SOURCE нет — так и скажи.
3. Правильно различай роли: «мне сказали», «она ответила», «кандидат написал» — это слова другого человека.
4. Если пользователь уже дал достаточно контекста, не задавай дополнительный вопрос — дай следующий шаг.
5. Если не хватает ОДНОГО факта, который пользователь сам знает и без которого нельзя выбрать решение, response_type="clarification" и задай один лёгкий вопрос с 3–6 вариантами ответа. Наводящий вопрос должен быть реально необходим.
6. Если причину можно выяснить только у кандидата/партнёра, не спрашивай пользователя «как ты думаешь». Дай готовую диагностическую реплику — это полноценный answer.
7. Если просят «что написать / что ответить / напиши сообщение», дай готовый текст без плейсхолдеров. Формат: короткое пояснение и «Я бы написал так:» + цитата «…».
8. Для новичка, который ничего не делает и причина неизвестна: сначала диагностика, а не список задач.
9. Для спящего партнёра: человеческий контакт → снять вину → выяснить причину выпадения → один маленький шаг.
10. Для суммы входа: не спорить и не давить; понять, останавливает ли сама сумма или непонятен смысл старта. Точные суммы называй только если они есть в SOURCE.
11. Для презентации/встречи: конкретная подготовка, вопросы, 2–3 уместных примера, следующий шаг; без обещаний дохода.
12. Не называй Greenleaf вакансией, работодателем, зарплатой или собеседованием без явного контекста найма.
13. Не используй слова SOURCE, внутренние id, служебную разметку или плейсхолдеры в пользовательском ответе.
14. Пиши по-русски, живо, конкретно. Простая ситуация — 60–140 слов, сложная — обычно до 220 слов.
15. Не начинай каждое сообщение с похвалы. Не дави, не стыди, не манипулируй.
16. Сохраняй контекст имён и местоимений из последних сообщений. Если пользователь пишет «она», используй известное имя, когда оно уже было в контексте.

SOURCE:
${renderSources(sources)}

Верни ТОЛЬКО JSON:
{"response_type":"clarification"|"answer","text":"финальный ответ пользователю","memory_update":"краткая рабочая память о людях, цели, возражении и текущем шаге"|null}`;
}

async function generateFastAnswer(
  profile: Profile,
  history: Array<{ role: string; content: string }>,
  userText: string,
  sources: RankedKnowledge[],
): Promise<FastResult | null> {
  const c = ai();
  if (!c) return null;
  try {
    const response = await c.chat.completions.create({
      model: PROXY_MODEL,
      messages: [
        { role: "system", content: buildSystem(profile.preferred_name || "партнёр", profile.memory_summary, sources) },
        ...history.slice(-10).map((item) => ({
          role: item.role === "assistant" ? "assistant" as const : "user" as const,
          content: item.content,
        })),
        { role: "user", content: userText },
      ],
      response_format: { type: "json_object" },
      temperature: 0.18,
      max_tokens: 950,
    });
    const raw = response.choices[0]?.message?.content || "{}";
    const parsed = JSON.parse(raw) as Partial<FastResult>;
    const text = typeof parsed.text === "string" ? sanitize(parsed.text) : "";
    if (!text) return null;
    const responseType = parsed.response_type === "clarification" ? "clarification" : "answer";
    return {
      response_type: responseType,
      text,
      memory_update: typeof parsed.memory_update === "string" ? parsed.memory_update.trim() : null,
    };
  } catch (err) {
    logger.warn({ err, timeoutMs: AI_TIMEOUT_MS }, "Jarvis v17 single-pass AI request failed or timed out");
    return null;
  }
}

function postGuard(userText: string, result: FastResult): FastResult {
  let text = sanitize(result.text);
  if (PLACEHOLDER_RE.test(text)) {
    return {
      response_type: "clarification",
      text: "Мне не хватает одной конкретной детали, чтобы дать готовый текст без шаблонных заглушек. Напиши, пожалуйста, кто этот человек тебе и что уже произошло между вами.",
      memory_update: result.memory_update,
    };
  }
  if (GUARANTEE_RE.test(text) && !GUARANTEE_RE.test(userText)) {
    text = text.replace(/гарантир(?:ованно|ует|ую)/giu, "может").replace(/точно\s+/giu, "");
  }
  if (READY_REQUEST_RE.test(userText) && result.response_type === "answer" && !READY_QUOTE_RE.test(text)) {
    logger.warn({ userText: userText.slice(0, 160) }, "Jarvis v17 answer-to-write request lacked ready quote");
  }
  return { ...result, text };
}

async function sendLongText(bot: TelegramBot, chatId: number, text: string): Promise<void> {
  const limit = 3800;
  if (text.length <= limit) {
    await bot.sendMessage(chatId, text);
    return;
  }
  let rest = text;
  while (rest.length > limit) {
    let split = rest.lastIndexOf("\n\n", limit);
    if (split < 1000) split = rest.lastIndexOf("\n", limit);
    if (split < 1000) split = limit;
    await bot.sendMessage(chatId, rest.slice(0, split).trim());
    rest = rest.slice(split).trim();
  }
  if (rest) await bot.sendMessage(chatId, rest);
}

async function canShowCta(userId: number): Promise<boolean> {
  const result = await pool.query<{ last_shown_at: Date }>(
    `SELECT last_shown_at FROM jarvis_site_cta_events WHERE telegram_user_id=$1`,
    [userId],
  );
  const last = result.rows[0]?.last_shown_at ? new Date(result.rows[0].last_shown_at) : null;
  return !last || Date.now() - last.getTime() >= CTA_COOLDOWN_MS;
}

async function rememberCta(userId: number, kind: CtaKind): Promise<void> {
  await pool.query(
    `INSERT INTO jarvis_site_cta_events (telegram_user_id, last_kind, last_shown_at)
     VALUES ($1,$2,NOW())
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

function ctaCopy(kind: CtaKind, personal: boolean): { text: string; button: string } {
  if (personal) {
    if (kind === "product") return { text: "🌿 Здесь удобно дать человеку именно твою персональную страницу с продукцией.", button: "🌿 Открыть мою страницу с продукцией →" };
    if (kind === "registration") return { text: "✅ На этом шаге можно использовать твою персональную страницу, чтобы человек не потерялся после разговора.", button: "✅ Открыть мою персональную страницу →" };
    return { text: "🌐 Здесь пригодится твоя персональная страница: одна ссылка вместо десятка сообщений.", button: "🌐 Открыть мою страницу для кандидата →" };
  }
  return { text: "🌐 В такой ситуации может пригодиться персональный сайт партнёра. Ниже можно посмотреть, как это работает.", button: "🌐 Посмотреть сайт партнёра →" };
}

async function maybeSendSiteCta(bot: TelegramBot, chatId: number, userId: number, userText: string, answerText: string): Promise<void> {
  try {
    const decision = decideJarvisSiteCta(userText, answerText);
    if (!decision || !(await canShowCta(userId))) return;
    const personal = await resolveJarvisPersonalSite(userId);
    const kind = decision.kind as CtaKind;
    const copy = ctaCopy(kind, Boolean(personal));
    const destination = personal?.url || SITE_URL;
    await bot.sendMessage(chatId, copy.text, {
      reply_markup: {
        inline_keyboard: [[{ text: copy.button, url: trackedUrl(destination, kind, Boolean(personal)) }]],
      },
    });
    await rememberCta(userId, kind);
    logger.info({ userId, kind, personalized: Boolean(personal), slug: personal?.slug || null }, "Jarvis v17 contextual site CTA shown");
  } catch (err) {
    logger.warn({ err, userId }, "Jarvis v17 site CTA failed after core answer");
  }
}

async function useLegacyHandshake(userId: number, profile: Profile | null): Promise<boolean> {
  if (!profile?.preferred_name) return true;
  const last = await lastAssistantText(userId);
  return /(?:как\s+тебя\s+зовут|как\s+мне\s+тебя\s+называть|напиши\s+только\s+имя|сначала\s+напиши.*имя)/iu.test(last);
}

export async function initJarvisV17(): Promise<void> {
  await initJarvisV16();
  await ensureSchema();
  logger.info({ aiTimeoutMs: AI_TIMEOUT_MS }, "Jarvis v17 single-pass local-RAG engine ready");
}

export async function handleJarvisV17Message(bot: TelegramBot, msg: Message): Promise<void> {
  const userId = msg.from?.id;
  const userText = msg.text?.trim() || "";

  if (!userId || !userText || userText.startsWith("/")) {
    await handleJarvisV16Message(bot, msg);
    return;
  }

  const profile = await loadProfile(userId);
  if (await useLegacyHandshake(userId, profile)) {
    await handleJarvisV16Message(bot, msg);
    return;
  }

  const quota = await normalizeQuota(userId);
  if (quota.locked) {
    await sendLocked(bot, msg.chat.id, userId, quota.lockedUntil);
    return;
  }

  if (activeUsers.has(userId)) {
    await bot.sendMessage(msg.chat.id, "Я ещё разбираю предыдущее сообщение. Дождись ответа — второй разбор сейчас не запускаю, чтобы не смешивать контекст.");
    logger.info({ userId }, "Jarvis v17 blocked overlapping request");
    return;
  }

  activeUsers.add(userId);
  const startedAt = Date.now();
  let finished = false;
  const typingTimer = setInterval(() => {
    if (!finished) void bot.sendChatAction(msg.chat.id, "typing").catch(() => undefined);
  }, TYPING_INTERVAL_MS);
  const slowTimer = setTimeout(() => {
    if (!finished) {
      void bot.sendMessage(msg.chat.id, "Собираю ответ по базе Greenleaf — ещё немного 👍").catch(() => undefined);
    }
  }, SLOW_NOTICE_MS);

  try {
    try { await bot.sendChatAction(msg.chat.id, "typing"); } catch {}
    const history = await recentHistory(userId);
    await saveMessage(userId, "user", userText, "user_message", false);
    const sources = await retrieveLocalKnowledge(userText, history);
    const generated = await generateFastAnswer(profile!, history, userText, sources);

    if (!generated) {
      await bot.sendMessage(
        msg.chat.id,
        "Не получил ответ от AI за разумное время. Лимит не списан. Попробуй отправить сообщение ещё раз — следующий запрос запустится с чистого листа.",
      );
      return;
    }

    const result = postGuard(userText, generated);
    await saveMemory(userId, result.memory_update);

    if (result.response_type === "clarification") {
      await saveMessage(userId, "assistant", result.text, "clarification", false);
      await sendLongText(bot, msg.chat.id, result.text);
      logger.info({ userId, durationMs: Date.now() - startedAt, kind: "clarification" }, "Jarvis v17 single-pass response completed");
      return;
    }

    const reserved = await reserveAnswer(userId);
    if (!reserved.allowed) {
      await sendLocked(bot, msg.chat.id, userId, reserved.lockedUntil);
      return;
    }

    await saveMessage(userId, "assistant", result.text, "answer", true);
    await sendLongText(bot, msg.chat.id, result.text);

    if (reserved.remaining === 5) {
      await bot.sendMessage(msg.chat.id, "Осталось 5 бесплатных полноценных ответов Джарвиса. Наводящие вопросы лимит не расходуют.");
    } else if (reserved.remaining === 1) {
      await bot.sendMessage(msg.chat.id, "Остался 1 бесплатный полноценный ответ Джарвиса. После него начнётся 7-дневная пауза, затем снова будут доступны 20 ответов.");
    } else if (reserved.remaining === 0) {
      await sendLocked(bot, msg.chat.id, userId, reserved.lockedUntil);
    } else {
      void maybeSendSiteCta(bot, msg.chat.id, userId, userText, result.text);
    }

    logger.info({ userId, durationMs: Date.now() - startedAt, kind: "answer", remaining: reserved.remaining }, "Jarvis v17 single-pass response completed");
  } catch (err) {
    logger.error({ err, userId }, "Jarvis v17 message handling failed");
    try { await bot.sendMessage(msg.chat.id, "Что-то пошло не так. Лимит не списан, если полноценный ответ не был отправлен. Попробуй ещё раз."); } catch {}
  } finally {
    finished = true;
    clearInterval(typingTimer);
    clearTimeout(slowTimer);
    activeUsers.delete(userId);
  }
}

export async function handleJarvisV17Callback(bot: TelegramBot, query: CallbackQuery): Promise<void> {
  await handleJarvisV16Callback(bot, query);
}
