import OpenAI from "openai";
import TelegramBot from "node-telegram-bot-api";
import type { CallbackQuery, Message } from "node-telegram-bot-api";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger.js";
import { handleJarvisV7Message, handleJarvisV7Callback, initJarvisV7 } from "./jarvisV7.js";
import { handleJarvisV6Message, sanitizeJarvisUserText } from "./jarvisV6.js";
import { renderRagContext, retrieveJarvisRag } from "./rag/jarvisRag.js";

const PROXY_BASE_URL = process.env.PROXY_API_BASE_URL || "https://api.proxyapi.ru/openai/v1";
const PROXY_MODEL = process.env.PROXY_API_MODEL || "gpt-4o-mini";
const AI_ENABLED = process.env.AI_ENABLED !== "false";
const LIMIT = 20;
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const APP_URL = process.env.JARVIS_APP_URL || "https://greenleaf-coach.replit.app";
const TIME_ZONE = process.env.JARVIS_TIME_ZONE || "Europe/Moscow";

let client: OpenAI | null = null;

type ChatId = Parameters<TelegramBot["sendMessage"]>[0];
type SendMessageArgs = Parameters<TelegramBot["sendMessage"]>;
type Mode = "ask_user" | "diagnostic_message" | "solution";
type FinalResult = { mode: Mode; text: string };
type LatestAssistant = { id: string; counted: boolean };
type QuotaDecision = { allowed: boolean; newlyCounted: boolean; remaining: number; lockedUntil: Date | null };

const INTERPERSONAL = /(?:партн[её]р|нович|кандидат|человек|знаком|клиент|переписк|сообщен|ответил|ответила|сказал|сказала|возражен|встреч|созвон|коллег)/iu;
const WHAT_TO_DO = /(?:что\s+(?:мне\s+)?делать|как\s+(?:мне\s+)?(?:поступить|помочь|ответить|написать|поговорить|продолжить)|что\s+(?:ему|ей)\s+(?:сказать|написать))/iu;
const ZERO_ACTION = /(?:никому\s+(?:ещ[её]\s+)?не\s+(?:написал|написала)|ничего\s+не\s+делает|только\s+(?:читает|изучает)|застрял|завис|перегруз|не\s+знает\s*,?\s+с\s+чего\s+начать)/iu;
const KNOWN_CAUSE = /(?:боится|страх|неувер|не\s+понимает|получил[а]?\s+[^.!?]{0,50}отказ|после\s+[^.!?]{0,50}отказ|нет\s+времени|нет\s+денег|дорого|пирамид|неинтерес|не\s+интерес|не\s+получается|перегруз|устал|выгорел|сдулся|стесняется|не\s+хочет)/iu;
const READY_REQUEST = /(?:как\s+написать|что\s+написать|напиши\s+(?:сообщение|ответ)|что\s+ответить|без\s+резкого\s+захода)/iu;
const FORMER_COLLEAGUE = /(?:бывш(?:ая|ей|ую)?\s+коллег|коллег(?:а|ой|у)).{0,100}(?:давно|год|лет|не\s+общ)|(?:давно|год|лет|не\s+общ).{0,100}(?:бывш(?:ая|ей|ую)?\s+коллег|коллег(?:а|ой|у))/iu;
const SOURCE = /(?:\(?\[?SOURCE\s*\d+(?:\s*[:#-]\s*[A-Za-z0-9_.:-]+)?\]?\)?)/giu;
const PLACEHOLDER = /\[[^\]]{1,80}\]|\{[^}]{1,80}\}|<[^>]{1,80}>|\b(?:ваша\s+сфера|ваше\s+имя|имя\s+собеседника|вставьте\s+(?:сюда|имя|тему))\b/iu;
const HR_DRIFT = /(?:заработн(?:ая|ой)\s+плат|ваканси|в\s+этой\s+позици|позици[яю]\s+или\s+компани|работодатель|собеседовани)/iu;
const SPECULATION = /(?:как\s+ты\s+(?:думаешь|считаешь)|как\s+тебе\s+кажется|(?:он|она)\s+(?:готов(?:а)?|открыт(?:а)?|захочет|согласится))[^.!?]{0,120}\?/iu;
const READY_QUOTE = /(?:«[^»]{15,}»|"[^"\n]{15,}")/u;
const PRICE_AND_PYRAMID = /(?=.*(?:дорог|цен|сумм))(?=.*пирамид)/iu;
const PYRAMID_COVERED = /(?:пирамид|модел|систем|структур|продукт|товарооборот|реальн(?:ый|ого)\s+товар)/iu;
const PREMATURE = /(?:состав(?:ить|ь)\s+(?:список|\d+\s+(?:им[её]н|контактов))|напис(?:ать|и)\s+(?:одному|человеку|людям)|назнач(?:ить|ь)\s+(?:встречу|созвон))/iu;
const SHORT_REQUEST = /(?:короче|кратко|только\s+(?:сообщение|текст|ответ)|одной\s+фразой|без\s+объяснений)/iu;
const EXACT_FACT = /(?:точн|официальн).*(?:выручк|оборот|отч[её]т|статистик|цифр)/iu;
const MEDICAL_GUARANTEE = /(?:вылеч|излеч|лечит|гарантир.*(?:здоров|леч)|точно\s+поможет.*(?:болез|проблем))/iu;

function ai(): OpenAI | null {
  if (!AI_ENABLED) return null;
  const key = process.env.PROXY_API_KEY || process.env.PROXY_API_TOKEN;
  if (!key) return null;
  if (!client) client = new OpenAI({ apiKey: key, baseURL: PROXY_BASE_URL });
  return client;
}

function clean(text: string): string {
  return sanitizeJarvisUserText(text)
    .replace(SOURCE, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\n\s+/g, "\n")
    .trim();
}

function diagnosticFirst(text: string): boolean {
  return INTERPERSONAL.test(text) && WHAT_TO_DO.test(text) && ZERO_ACTION.test(text) && !KNOWN_CAUSE.test(text);
}

function warmEnough(text: string): boolean {
  return FORMER_COLLEAGUE.test(text) && READY_REQUEST.test(text);
}

function skipFinalRewrite(userText: string, outgoing: string): boolean {
  if (!userText || userText.startsWith("/")) return true;
  if (SHORT_REQUEST.test(userText)) return true;
  if (outgoing.length < 35) return true;
  if (/^(?:🔒|Осталось\s+\d+|Остался\s+\d+|Сейчас не получилось|Что-то пошло не так)/iu.test(outgoing)) return true;
  if (/бесплатн(?:ый|ых|ого)\s+(?:лимит|ответ)/iu.test(outgoing)) return true;
  if (/приятно\s+познакомиться|рад\s+знакомству/iu.test(outgoing)) return true;
  return false;
}

async function history(userId: number): Promise<Array<{ role: string; content: string }>> {
  const r = await pool.query<{ role: string; content: string }>(
    `SELECT role, content FROM (
       SELECT id, role, content FROM jarvis_messages
       WHERE telegram_user_id=$1 AND role IN ('user','assistant')
       ORDER BY id DESC LIMIT 12
     ) q ORDER BY id ASC`,
    [userId],
  );
  return r.rows;
}

async function latestAssistant(userId: number): Promise<LatestAssistant | null> {
  const r = await pool.query<LatestAssistant>(
    `SELECT id::text, counted FROM jarvis_messages
     WHERE telegram_user_id=$1 AND role='assistant' ORDER BY id DESC LIMIT 1`,
    [userId],
  );
  return r.rows[0] || null;
}

async function finalSynthesis(userId: number, userText: string, draft: string): Promise<FinalResult | null> {
  const c = ai();
  if (!c) return null;
  try {
    const h = await history(userId);
    const hits = await retrieveJarvisRag(`${h.map(x => x.content).join("\n")}\n${userText}\n${draft}`, 7);
    const response = await c.chat.completions.create({
      model: PROXY_MODEL,
      messages: [{
        role: "system",
        content: `Ты — финальный редактор Джарвиса, нейропомощника партнёра Greenleaf. Используй только переданные SOURCE и факты диалога. Не добавляй факты из общей памяти.

Определи режим:
- ask_user: не хватает факта, который пользователь уже может знать. Задай один лёгкий вопрос.
- diagnostic_message: причину можно выяснить только у другого человека. Дай готовую реплику для отправки.
- solution: данных достаточно. Дай конкретный разбор и действие; если действие связано с общением — готовую реплику.

ЖЁСТКИЕ ПРАВИЛА:
1. Если diagnostic_first=true: причина бездействия неизвестна. Только diagnostic_message. Не назначай список, сообщения, встречу, созвон или другой рабочий шаг до ответа человека.
2. Если warm_context_sufficient=true: контекста бывшего коллеги уже достаточно. Не спрашивай «дружески/официально/нейтрально» — дай готовый текст.
3. Если combined_price_pyramid=true: нельзя потерять ни цену, ни сомнение «пирамида». Учти оба или явно спроси, что из этих двух беспокоит сильнее, назвав оба.
4. Greenleaf — не вакансия. Не используй «зарплата», «позиция», «вакансия», «работодатель», «собеседование» без явного контекста найма.
5. Если exact_fact=true и SOURCE не содержит точного подтверждения: скажи прямо, что в подтверждённой базе нет данных для точного ответа. Не выдумывай ссылки, отчёты и отделы.
6. Если medical_guarantee=true: не обещай лечение и не заменяй гарантию расплывчатым «может помочь решить проблему», если это не подтверждено SOURCE.
7. Без SOURCE, плейсхолдеров, канцелярита и гадания о чужой готовности в пользовательском тексте.
8. Живой русский тон наставника. Не начинай каждое сообщение с похвалы.
9. Простая ситуация — кратко; сложная — обычно 100–220 слов.

SOURCE:
${renderRagContext(hits)}

Верни только JSON: {"mode":"ask_user"|"diagnostic_message"|"solution","text":"ответ"}`,
      }, {
        role: "user",
        content: JSON.stringify({
          user_message: userText,
          previous_draft: draft,
          recent_context: h.slice(-8),
          diagnostic_first: diagnosticFirst(userText),
          warm_context_sufficient: warmEnough(userText),
          combined_price_pyramid: PRICE_AND_PYRAMID.test(userText),
          exact_fact: EXACT_FACT.test(userText),
          medical_guarantee: MEDICAL_GUARANTEE.test(userText),
        }),
      }],
      response_format: { type: "json_object" },
      temperature: 0.08,
      max_tokens: 1300,
    });
    const parsed = JSON.parse(response.choices[0]?.message?.content || "{}") as Partial<FinalResult>;
    const text = typeof parsed.text === "string" ? clean(parsed.text) : "";
    if (!text) return null;
    const mode: Mode = parsed.mode === "ask_user" ? "ask_user" : parsed.mode === "diagnostic_message" ? "diagnostic_message" : "solution";
    return { mode, text };
  } catch (err) {
    logger.warn({ err }, "Jarvis v9 final synthesis failed");
    return null;
  }
}

function invalid(userText: string, result: FinalResult): boolean {
  const t = result.text;
  if (PLACEHOLDER.test(t) || HR_DRIFT.test(t) || SPECULATION.test(t)) return true;
  if (diagnosticFirst(userText) && (result.mode !== "diagnostic_message" || !READY_QUOTE.test(t) || PREMATURE.test(t))) return true;
  if (warmEnough(userText) && result.mode === "ask_user") return true;
  if (PRICE_AND_PYRAMID.test(userText) && !PYRAMID_COVERED.test(t)) return true;
  if (MEDICAL_GUARANTEE.test(userText) && /(?:вылеч|излеч|может\s+помочь.*(?:решить|лечить))/iu.test(t)) return true;
  return false;
}

async function repair(userId: number, userText: string, result: FinalResult): Promise<FinalResult | null> {
  const c = ai();
  if (!c) return null;
  try {
    const hits = await retrieveJarvisRag(`${userText}\n${result.text}`, 6);
    const response = await c.chat.completions.create({
      model: PROXY_MODEL,
      messages: [{
        role: "system",
        content: `Исправь ответ Джарвиса строго по SOURCE. Нельзя: HR-язык, SOURCE/плейсхолдеры, потеря одного из нескольких возражений, лишнее уточнение при достаточном контексте, неподтверждённые факты, медицинские/доходные гарантии. Если причина бездействия неизвестна — только готовое диагностическое сообщение без рабочего задания. Верни JSON {"mode":"ask_user"|"diagnostic_message"|"solution","text":"..."}.\n\nSOURCE:\n${renderRagContext(hits)}`,
      }, {
        role: "user",
        content: JSON.stringify({ user_message: userText, previous: result }),
      }],
      response_format: { type: "json_object" },
      temperature: 0.03,
      max_tokens: 1300,
    });
    const parsed = JSON.parse(response.choices[0]?.message?.content || "{}") as Partial<FinalResult>;
    const text = typeof parsed.text === "string" ? clean(parsed.text) : "";
    if (!text) return null;
    return { mode: parsed.mode === "ask_user" ? "ask_user" : parsed.mode === "diagnostic_message" ? "diagnostic_message" : "solution", text };
  } catch (err) {
    logger.warn({ err }, "Jarvis v9 repair failed");
    return null;
  }
}

function diagnosticFallback(): FinalResult {
  return {
    mode: "diagnostic_message",
    text: `По описанию видно одно: человек пока не перешёл от изучения к действию. Но почему именно — мы ещё не знаем. Поэтому не стоит назначать ему задачу наугад или давать ещё больше информации.\n\nЯ бы написал так:\n\n«Слушай, вижу, что ты серьёзно изучаешь материалы. Хочу понять без давления: тебе сейчас просто нужно ещё немного времени разобраться или информации уже стало много и пока непонятно, с чего лучше начать? Если что-то тормозит — скажи как есть, разберём спокойно».\n\nСначала дождись ответа. Уже по нему будет понятно, нужен маленький первый шаг, помощь со страхом или просто время. Пришли его ответ — разберём дальше.`,
  };
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("ru-RU", { timeZone: TIME_ZONE, day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }).format(date);
}

async function nameOf(userId: number): Promise<string> {
  const r = await pool.query<{ preferred_name: string | null }>("SELECT preferred_name FROM jarvis_profiles WHERE telegram_user_id=$1", [userId]);
  return r.rows[0]?.preferred_name || "друг";
}

async function lockedMessage(target: TelegramBot, chatId: ChatId, userId: number, until: Date | null): Promise<any> {
  const name = await nameOf(userId);
  const date = until || new Date(Date.now() + WINDOW_MS);
  return target.sendMessage(chatId,
    `🔒 ${name}, бесплатный лимит Джарвиса на этот период закончился.\n\nСледующие 20 полноценных ответов станут доступны ${formatDate(date)}.\n\nИли можно продолжить этот разбор в Greenleaf Coach.`,
    { reply_markup: { inline_keyboard: [[{ text: "Продолжить этот разбор в Greenleaf Coach →", url: APP_URL }]] } },
  );
}

async function reserveIfNeeded(userId: number): Promise<QuotaDecision> {
  const latest = await latestAssistant(userId);
  if (!latest) return { allowed: true, newlyCounted: false, remaining: LIMIT, lockedUntil: null };

  if (latest.counted) {
    const r = await pool.query<{ answers_used: number; locked_until: Date | null }>("SELECT answers_used, locked_until FROM jarvis_usage WHERE telegram_user_id=$1", [userId]);
    const row = r.rows[0];
    return { allowed: true, newlyCounted: false, remaining: Math.max(0, LIMIT - Number(row?.answers_used || 0)), lockedUntil: row?.locked_until ? new Date(row.locked_until) : null };
  }

  const cx = await pool.connect();
  try {
    await cx.query("BEGIN");
    await cx.query("INSERT INTO jarvis_usage (telegram_user_id) VALUES ($1) ON CONFLICT (telegram_user_id) DO NOTHING", [userId]);
    const s = await cx.query<{ answers_used: number; window_started_at: Date | null }>("SELECT answers_used, window_started_at FROM jarvis_usage WHERE telegram_user_id=$1 FOR UPDATE", [userId]);
    const row = s.rows[0];
    const now = new Date();
    const oldStart = row.window_started_at ? new Date(row.window_started_at) : null;
    const expired = !!oldStart && now.getTime() >= oldStart.getTime() + WINDOW_MS;
    const used = expired ? 0 : Number(row.answers_used || 0);
    const start = expired || !oldStart ? now : oldStart;
    if (used >= LIMIT) {
      const until = new Date(start.getTime() + WINDOW_MS);
      await cx.query("UPDATE jarvis_usage SET locked_until=$2, updated_at=NOW() WHERE telegram_user_id=$1", [userId, until]);
      await cx.query("COMMIT");
      return { allowed: false, newlyCounted: false, remaining: 0, lockedUntil: until };
    }
    const next = used + 1;
    const until = next >= LIMIT ? new Date(start.getTime() + WINDOW_MS) : null;
    await cx.query("UPDATE jarvis_usage SET answers_used=$2, window_started_at=$3, locked_until=$4, updated_at=NOW() WHERE telegram_user_id=$1", [userId, next, start, until]);
    await cx.query("UPDATE jarvis_messages SET counted=TRUE, message_type='answer' WHERE id=$1::bigint", [latest.id]);
    await cx.query("COMMIT");
    return { allowed: true, newlyCounted: true, remaining: LIMIT - next, lockedUntil: until };
  } catch (err) {
    await cx.query("ROLLBACK");
    throw err;
  } finally {
    cx.release();
  }
}

async function updateLatest(userId: number, text: string): Promise<void> {
  await pool.query(`UPDATE jarvis_messages SET content=$2 WHERE id=(SELECT id FROM jarvis_messages WHERE telegram_user_id=$1 AND role='assistant' ORDER BY id DESC LIMIT 1)`, [userId, text]);
}

function proxyBot(bot: TelegramBot, userId: number, userText: string, onFinal: (text: string) => void): TelegramBot {
  let handled = false;
  return new Proxy(bot, {
    get(target, prop, receiver) {
      if (prop === "sendMessage") {
        return async (...args: SendMessageArgs) => {
          const [chatId, outgoing, options] = args;
          if (handled || skipFinalRewrite(userText, outgoing)) return target.sendMessage(chatId, outgoing, options);
          handled = true;

          let result = await finalSynthesis(userId, userText, outgoing);
          if (!result) return target.sendMessage(chatId, outgoing, options);
          if (invalid(userText, result)) result = (await repair(userId, userText, result)) || result;
          if (invalid(userText, result) && diagnosticFirst(userText)) result = diagnosticFallback();

          const latest = await latestAssistant(userId);
          if (latest?.counted && result.mode === "ask_user") {
            result = { mode: "solution", text: clean(outgoing) };
          }

          if (result.mode === "ask_user") {
            const text = clean(result.text);
            onFinal(text);
            logger.info({ mode: result.mode }, "Jarvis v9 final layer applied");
            return target.sendMessage(chatId, text, options);
          }

          const quota = await reserveIfNeeded(userId);
          if (!quota.allowed) {
            logger.warn({ userId }, "Jarvis v9 blocked answer: no quota slot");
            return lockedMessage(target, chatId, userId, quota.lockedUntil);
          }

          const text = clean(result.text);
          onFinal(text);
          const sent = await target.sendMessage(chatId, text, options);
          if (quota.newlyCounted) {
            if (quota.remaining === 5) await target.sendMessage(chatId, "Осталось 5 бесплатных полноценных ответов Джарвиса. Наводящие вопросы лимит не расходуют.");
            else if (quota.remaining === 1) await target.sendMessage(chatId, "Остался 1 бесплатный полноценный ответ Джарвиса в текущем 7-дневном периоде.");
            else if (quota.remaining === 0) await lockedMessage(target, chatId, userId, quota.lockedUntil);
          }
          logger.info({ mode: result.mode, quotaReconciled: quota.newlyCounted }, "Jarvis v9 final layer applied");
          return sent;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as TelegramBot;
}

export async function initJarvisV9(): Promise<void> {
  await initJarvisV7();
  logger.info("Jarvis v9 atomic quota + release quality ready");
}

export async function handleJarvisV9Message(bot: TelegramBot, msg: Message): Promise<void> {
  const userId = msg.from?.id;
  const text = msg.text?.trim() || "";
  if (!userId) return handleJarvisV7Message(bot, msg);

  // Preserve deterministic onboarding/name handshake without AI rewriting.
  if (text && !text.startsWith("/")) {
    const p = await pool.query<{ preferred_name: string | null }>("SELECT preferred_name FROM jarvis_profiles WHERE telegram_user_id=$1", [userId]);
    if (!p.rows[0]?.preferred_name) return handleJarvisV6Message(bot, msg);
  }

  const lock = await pool.connect();
  try {
    await lock.query("SELECT pg_advisory_lock($1::bigint)", [userId]);
    let final: string | null = null;
    const wrapped = proxyBot(bot, userId, text, (v) => { final = v; });
    await handleJarvisV7Message(wrapped, msg);
    if (final) await updateLatest(userId, final);
  } finally {
    try { await lock.query("SELECT pg_advisory_unlock($1::bigint)", [userId]); } catch {}
    lock.release();
  }
}

export async function handleJarvisV9Callback(bot: TelegramBot, query: CallbackQuery): Promise<void> {
  await handleJarvisV7Callback(bot, query);
}
