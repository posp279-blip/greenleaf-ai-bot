import OpenAI from "openai";
import TelegramBot from "node-telegram-bot-api";
import type { CallbackQuery, Message } from "node-telegram-bot-api";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger.js";
import {
  handleJarvisMessage as handleLegacyJarvisMessage,
  handleJarvisCallback,
  initJarvis,
} from "./jarvisV4.js";
import { initJarvisRag, renderRagContext, retrieveJarvisRag } from "./rag/jarvisRag.js";
import type { JarvisRagHit } from "./rag/jarvisSourceTypes.js";

const FREE_ANSWER_LIMIT = 20;
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const APP_URL = process.env.JARVIS_APP_URL || "https://greenleaf-coach.replit.app";
const TIME_ZONE = process.env.JARVIS_TIME_ZONE || "Europe/Moscow";
const PROXY_BASE_URL = process.env.PROXY_API_BASE_URL || "https://api.proxyapi.ru/openai/v1";
const PROXY_MODEL = process.env.PROXY_API_MODEL || "gpt-4o-mini";
const AI_ENABLED = process.env.AI_ENABLED !== "false";

let client: OpenAI | null = null;
let v5Ready = false;

type Profile = {
  preferred_name: string | null;
  memory_summary: string | null;
};

type UsageStatus = {
  answersUsed: number;
  remaining: number;
  windowStartedAt: Date | null;
  lockedUntil: Date | null;
  locked: boolean;
};

type DraftResult = {
  response_type: "clarification" | "answer";
  task_type: "draft" | "objection" | "chat_analysis" | "meeting" | "partner" | "plan" | "fact" | "other";
  text: string;
  used_source_ids: string[];
  memory_update?: string | null;
};

type ReviewResult = {
  pass: boolean;
  groundedness: number;
  specificity: number;
  generic: boolean;
  role_correct: boolean;
  violations: string[];
  text: string;
  used_source_ids: string[];
};

function getClient(): OpenAI | null {
  if (!AI_ENABLED) return null;
  const key = process.env.PROXY_API_KEY || process.env.PROXY_API_TOKEN;
  if (!key) return null;
  if (!client) client = new OpenAI({ apiKey: key, baseURL: PROXY_BASE_URL });
  return client;
}

export async function initJarvisV5(): Promise<void> {
  if (v5Ready) return;
  await initJarvis();
  await initJarvisRag();
  v5Ready = true;
  logger.info("Jarvis v5 source-grounded engine ready");
}

async function loadProfile(userId: number): Promise<Profile | null> {
  const result = await pool.query<Profile>(
    `SELECT preferred_name, memory_summary FROM jarvis_profiles WHERE telegram_user_id = $1`,
    [userId],
  );
  return result.rows[0] || null;
}

async function recentHistory(userId: number, limit = 26): Promise<Array<{ role: string; content: string }>> {
  const result = await pool.query<{ role: string; content: string }>(
    `SELECT role, content FROM (
       SELECT id, role, content
       FROM jarvis_messages
       WHERE telegram_user_id = $1 AND role IN ('user','assistant')
       ORDER BY id DESC LIMIT $2
     ) h ORDER BY id ASC`,
    [userId, limit],
  );
  return result.rows;
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
  if (!memory?.trim()) return;
  await pool.query(
    `UPDATE jarvis_profiles SET memory_summary = $2, updated_at = NOW() WHERE telegram_user_id = $1`,
    [userId, memory.trim().slice(0, 2500)],
  );
}

async function getUsageStatus(userId: number): Promise<UsageStatus> {
  await pool.query(
    `INSERT INTO jarvis_usage (telegram_user_id) VALUES ($1)
     ON CONFLICT (telegram_user_id) DO NOTHING`,
    [userId],
  );

  const result = await pool.query<{
    answers_used: number;
    window_started_at: Date | null;
    locked_until: Date | null;
  }>(
    `SELECT answers_used, window_started_at, locked_until FROM jarvis_usage WHERE telegram_user_id = $1`,
    [userId],
  );
  let row = result.rows[0];
  const now = Date.now();

  if (row.window_started_at && now >= new Date(row.window_started_at).getTime() + WINDOW_MS) {
    const reset = await pool.query<{
      answers_used: number;
      window_started_at: Date | null;
      locked_until: Date | null;
    }>(
      `UPDATE jarvis_usage
       SET answers_used = 0, window_started_at = NULL, locked_until = NULL, updated_at = NOW()
       WHERE telegram_user_id = $1
       RETURNING answers_used, window_started_at, locked_until`,
      [userId],
    );
    row = reset.rows[0];
  }

  const lockedUntil = row.locked_until ? new Date(row.locked_until) : null;
  return {
    answersUsed: row.answers_used,
    remaining: Math.max(0, FREE_ANSWER_LIMIT - row.answers_used),
    windowStartedAt: row.window_started_at ? new Date(row.window_started_at) : null,
    lockedUntil,
    locked: row.answers_used >= FREE_ANSWER_LIMIT && !!lockedUntil && lockedUntil.getTime() > now,
  };
}

async function consumeAnswer(userId: number): Promise<UsageStatus> {
  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");
    let selected = await connection.query<{
      answers_used: number;
      window_started_at: Date | null;
      locked_until: Date | null;
    }>(
      `SELECT answers_used, window_started_at, locked_until
       FROM jarvis_usage WHERE telegram_user_id = $1 FOR UPDATE`,
      [userId],
    );
    if (!selected.rows[0]) {
      await connection.query(`INSERT INTO jarvis_usage (telegram_user_id) VALUES ($1)`, [userId]);
      selected = await connection.query(
        `SELECT answers_used, window_started_at, locked_until
         FROM jarvis_usage WHERE telegram_user_id = $1 FOR UPDATE`,
        [userId],
      );
    }

    const row = selected.rows[0];
    const now = new Date();
    const previousStart = row.window_started_at ? new Date(row.window_started_at) : null;
    const expired = !!previousStart && now.getTime() >= previousStart.getTime() + WINDOW_MS;
    const used = expired ? 0 : row.answers_used;
    const windowStart = expired || !previousStart ? now : previousStart;
    if (used >= FREE_ANSWER_LIMIT) {
      const lockedUntil = new Date(windowStart.getTime() + WINDOW_MS);
      await connection.query(
        `UPDATE jarvis_usage SET locked_until = $2, updated_at = NOW() WHERE telegram_user_id = $1`,
        [userId, lockedUntil],
      );
      await connection.query("COMMIT");
      return { answersUsed: used, remaining: 0, windowStartedAt: windowStart, lockedUntil, locked: true };
    }

    const nextUsed = used + 1;
    const lockedUntil = nextUsed >= FREE_ANSWER_LIMIT ? new Date(windowStart.getTime() + WINDOW_MS) : null;
    await connection.query(
      `UPDATE jarvis_usage
       SET answers_used = $2, window_started_at = $3, locked_until = $4, updated_at = NOW()
       WHERE telegram_user_id = $1`,
      [userId, nextUsed, windowStart, lockedUntil],
    );
    await connection.query("COMMIT");
    return {
      answersUsed: nextUsed,
      remaining: Math.max(0, FREE_ANSWER_LIMIT - nextUsed),
      windowStartedAt: windowStart,
      lockedUntil,
      locked: nextUsed >= FREE_ANSWER_LIMIT,
    };
  } catch (err) {
    await connection.query("ROLLBACK");
    throw err;
  } finally {
    connection.release();
  }
}

function formatDateTime(date: Date): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: TIME_ZONE,
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

async function sendLocked(bot: TelegramBot, chatId: number, name: string, status: UsageStatus): Promise<void> {
  const until = status.lockedUntil || new Date(Date.now() + WINDOW_MS);
  await bot.sendMessage(
    chatId,
    `🔒 ${name}, бесплатный лимит Джарвиса на этот период закончился.\n\nСледующие 20 полноценных ответов станут доступны ${formatDateTime(until)}.\n\nИли можно продолжить этот разбор в Greenleaf Coach.`,
    { reply_markup: { inline_keyboard: [[{ text: "Продолжить этот разбор в Greenleaf Coach →", url: APP_URL }]] } },
  );
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

function toHistory(history: Array<{ role: string; content: string }>): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return history.map((item) => ({
    role: item.role === "assistant" ? "assistant" : "user",
    content: item.content,
  }));
}

function parseDraft(raw: string): DraftResult | null {
  try {
    const value = JSON.parse(raw) as Partial<DraftResult>;
    if (!value.text?.trim()) return null;
    const validTask = ["draft","objection","chat_analysis","meeting","partner","plan","fact","other"].includes(value.task_type || "");
    return {
      response_type: value.response_type === "clarification" ? "clarification" : "answer",
      task_type: validTask ? value.task_type! : "other",
      text: value.text.trim(),
      used_source_ids: Array.isArray(value.used_source_ids) ? value.used_source_ids.filter((id): id is string => typeof id === "string") : [],
      memory_update: typeof value.memory_update === "string" ? value.memory_update.trim() : null,
    };
  } catch {
    return null;
  }
}

function parseReview(raw: string): ReviewResult | null {
  try {
    const value = JSON.parse(raw) as Partial<ReviewResult>;
    if (!value.text?.trim()) return null;
    return {
      pass: value.pass === true,
      groundedness: typeof value.groundedness === "number" ? value.groundedness : 0,
      specificity: typeof value.specificity === "number" ? value.specificity : 0,
      generic: value.generic === true,
      role_correct: value.role_correct !== false,
      violations: Array.isArray(value.violations) ? value.violations.map(String) : [],
      text: value.text.trim(),
      used_source_ids: Array.isArray(value.used_source_ids) ? value.used_source_ids.filter((id): id is string => typeof id === "string") : [],
    };
  } catch {
    return null;
  }
}

function hasPlaceholder(text: string): boolean {
  return /\[[^\]]{1,80}\]|\{[^}]{1,80}\}|<[^>]{1,80}>|\b(?:ваша\s+сфера|ваше\s+имя|имя\s+собеседника|вставьте\s+(?:сюда|имя|тему)|укажите\s+(?:имя|тему))\b/iu.test(text);
}

function sourceIdsAreValid(ids: string[], hits: JarvisRagHit[]): boolean {
  const allowed = new Set(hits.map((hit) => hit.id));
  return ids.every((id) => allowed.has(id));
}

function buildDraftSystem(name: string, memory: string | null, hits: JarvisRagHit[]): string {
  return `Ты — Джарвис, нейропомощник партнёра Greenleaf. Ты не отвечаешь из общей памяти модели, когда вопрос относится к работе партнёра. Сначала опирайся на переданные SOURCE-фрагменты Greenleaf Coach.

Пользователь: ${name}
Рабочая память: ${memory || "нет"}

ИЕРАРХИЯ ИСТОЧНИКОВ:
1. methodology, authority 90–100, verified=true — основной норматив для рекомендаций и последовательности действий.
2. company_fact/product_catalog — только для конкретных фактов, если verified=true и источник действительно передан.
3. examples — только как примеры формулировок. Нельзя превращать неподтверждённые цифры, статистику, сертификаты, доходы, медицинские свойства или истории успеха в факты.

ПРАВИЛА РАБОТЫ:
- Сначала пойми роли. «Мне сказали/он ответил/кандидат написал» — это слова собеседника, а не мнение пользователя.
- Если методика источника говорит, что перед действием нужно диагностировать причину, а причина неизвестна, задай ОДИН наводящий вопрос с 3–6 примерами ответа. Это clarification и лимит не расходует.
- Не задавай вопрос, если ответ уже есть в контексте.
- Если просят написать сообщение — дай полностью готовый текст для копирования, без [Имя], [тема], {вставьте}, выдуманных интересов и биографии.
- Не делай «общий полезный совет», если в источниках есть конкретный алгоритм, шаги, типы или диагностические вопросы. Используй именно их логику.
- Не цитируй документ длинными кусками. Переводи методику в живой ответ под ситуацию.
- Если подтверждённого факта нет в high-authority/verified источниках — скажи, что подтверждённой информации недостаточно.
- Не обещай доход, окупаемость, лечение, юридическую легитимность или гарантированный результат.
- Не дави, не стыди, не манипулируй.
- Пиши по-русски, живо и конкретно. Обычный ответ 50–180 слов.
- Если ответ — готовое сообщение, сначала «Я бы написал так:», затем текст. Объяснение максимум 1–2 предложения.
- После полноценного решения можно одной строкой предложить прислать следующий ответ собеседника.

SOURCE-ФРАГМЕНТЫ:
${renderRagContext(hits)}

Верни ТОЛЬКО JSON:
{
  "response_type":"clarification"|"answer",
  "task_type":"draft"|"objection"|"chat_analysis"|"meeting"|"partner"|"plan"|"fact"|"other",
  "text":"ответ пользователю",
  "used_source_ids":["только id реально использованных SOURCE"],
  "memory_update":"краткая рабочая память: кто второй участник, отношения, цель, причина/возражение, текущий шаг"|null
}`;
}

async function createDraft(
  name: string,
  memory: string | null,
  history: Array<{ role: string; content: string }>,
  userText: string,
  hits: JarvisRagHit[],
): Promise<DraftResult | null> {
  const c = getClient();
  if (!c) return null;
  const response = await c.chat.completions.create({
    model: PROXY_MODEL,
    messages: [
      { role: "system", content: buildDraftSystem(name, memory, hits) },
      ...toHistory(history.slice(-18)),
      { role: "user", content: userText },
    ],
    response_format: { type: "json_object" },
    temperature: 0.22,
    max_tokens: 1100,
  });
  return parseDraft(response.choices[0]?.message?.content || "{}");
}

async function reviewDraft(
  userText: string,
  history: Array<{ role: string; content: string }>,
  hits: JarvisRagHit[],
  draft: DraftResult,
): Promise<ReviewResult | null> {
  const c = getClient();
  if (!c) return null;
  const response = await c.chat.completions.create({
    model: PROXY_MODEL,
    messages: [{
      role: "system",
      content: `Ты — строгий редактор качества Greenleaf Coach. Проверяешь ответ Джарвиса на соответствие SOURCE-фрагментам, а не на общую правдоподобность.

КРИТЕРИИ PASS:
- groundedness >= 0.82: рекомендация следует конкретной логике источников;
- specificity >= 0.80: использованы конкретные шаги/диагностика источника, а не банальный общий совет;
- роли пользователя и собеседника не перепутаны;
- нет плейсхолдеров и выдуманных фактов;
- если источник предписывает сначала выяснить причину (например, выпадение партнёра), а причины нет — ответ должен быть clarification, а не готовое универсальное сообщение;
- examples с низким authority не могут подтверждать цифры, сертификаты, медицинские, юридические или доходные факты;
- если пользователь просит готовый текст и данных достаточно — текст должен быть готов к отправке.

Если draft не проходит, перепиши его полностью на основе SOURCE. Не добавляй неподтверждённые факты.

SOURCE:
${renderRagContext(hits)}

ПОСЛЕДНИЙ КОНТЕКСТ:
${history.slice(-8).map((m) => `${m.role}: ${m.content}`).join("\n")}

ВОПРОС:
${userText}

DRAFT:
${JSON.stringify(draft)}

Верни ТОЛЬКО JSON:
{
 "pass":true|false,
 "groundedness":0..1,
 "specificity":0..1,
 "generic":true|false,
 "role_correct":true|false,
 "violations":["..."],
 "text":"исходный или исправленный финальный текст",
 "used_source_ids":["id фактически использованных источников"]
}`,
    }],
    response_format: { type: "json_object" },
    temperature: 0.1,
    max_tokens: 1100,
  });
  return parseReview(response.choices[0]?.message?.content || "{}");
}

function safeNoSourceReply(): DraftResult {
  return {
    response_type: "clarification",
    task_type: "other",
    text: "По этой ситуации я сейчас не нашёл достаточно конкретной опоры в базе Greenleaf Coach, поэтому не хочу додумывать. Уточни, пожалуйста, что именно происходит и какого результата ты хочешь добиться — тогда я попробую найти нужную методику точнее.",
    used_source_ids: [],
    memory_update: null,
  };
}

async function answerGrounded(
  name: string,
  memory: string | null,
  history: Array<{ role: string; content: string }>,
  userText: string,
): Promise<DraftResult | null> {
  const retrievalQuery = `${memory || ""}\n${history.slice(-12).map((m) => m.content).join("\n")}\n${userText}`;
  const hits = await retrieveJarvisRag(retrievalQuery, 8);
  if (!hits.length) return safeNoSourceReply();

  let draft = await createDraft(name, memory, history, userText, hits);
  if (!draft) return null;
  if (!sourceIdsAreValid(draft.used_source_ids, hits)) draft.used_source_ids = [];

  const review = await reviewDraft(userText, history, hits, draft);
  if (review) {
    const reviewIdsValid = sourceIdsAreValid(review.used_source_ids, hits);
    const shouldReplace = !review.pass || review.groundedness < 0.82 || review.specificity < 0.8 || review.generic || !review.role_correct;
    if (shouldReplace || review.text !== draft.text) {
      logger.info({
        groundedness: review.groundedness,
        specificity: review.specificity,
        generic: review.generic,
        violations: review.violations,
      }, "Jarvis v5 groundedness reviewer revised answer");
      draft = {
        ...draft,
        text: review.text,
        used_source_ids: reviewIdsValid ? review.used_source_ids : draft.used_source_ids,
      };
    }
  }

  if (hasPlaceholder(draft.text)) {
    logger.warn({ text: draft.text.slice(0, 300) }, "Jarvis v5 blocked placeholder answer");
    return {
      response_type: "clarification",
      task_type: "draft",
      text: "Чтобы написать готовое сообщение без шаблонных заглушек, мне не хватает одной детали о человеке или ситуации. Напиши её своими словами — например, кто он тебе и что уже происходило между вами.",
      used_source_ids: draft.used_source_ids,
      memory_update: draft.memory_update,
    };
  }

  return draft;
}

export async function handleJarvisV5Message(bot: TelegramBot, msg: Message): Promise<void> {
  const userId = msg.from?.id;
  const text = msg.text?.trim() || "";
  if (!userId) return;

  await initJarvisV5();

  // Commands, onboarding, name changes and empty/non-text messages stay in the proven base flow.
  if (!text || text.startsWith("/")) {
    await handleLegacyJarvisMessage(bot, msg);
    return;
  }

  const profile = await loadProfile(userId);
  if (!profile?.preferred_name) {
    await handleLegacyJarvisMessage(bot, msg);
    return;
  }

  const usage = await getUsageStatus(userId);
  if (usage.locked) {
    await sendLocked(bot, msg.chat.id, profile.preferred_name, usage);
    return;
  }

  const history = await recentHistory(userId);
  await saveMessage(userId, "user", text, "user_message", false);
  try { await bot.sendChatAction(msg.chat.id, "typing"); } catch {}

  try {
    const result = await answerGrounded(profile.preferred_name, profile.memory_summary, history, text);
    if (!result) {
      await bot.sendMessage(msg.chat.id, "Сейчас не получилось получить ответ Джарвиса. Лимит не списан. Попробуй ещё раз чуть позже.");
      return;
    }

    await saveMemory(userId, result.memory_update);
    if (result.response_type === "clarification") {
      await saveMessage(userId, "assistant", result.text, "clarification", false);
      await sendLongText(bot, msg.chat.id, result.text);
      return;
    }

    const consumed = await consumeAnswer(userId);
    await saveMessage(userId, "assistant", result.text, "answer", true);
    await sendLongText(bot, msg.chat.id, result.text);

    if (consumed.remaining === 5) {
      await bot.sendMessage(msg.chat.id, "Осталось 5 бесплатных полноценных ответов Джарвиса. Наводящие вопросы лимит не расходуют.");
    } else if (consumed.remaining === 1) {
      await bot.sendMessage(msg.chat.id, "Остался 1 бесплатный полноценный ответ Джарвиса в текущем 7-дневном периоде.");
    } else if (consumed.remaining === 0) {
      await sendLocked(bot, msg.chat.id, profile.preferred_name, consumed);
    }
  } catch (err) {
    logger.error({ err, userId }, "Jarvis v5 grounded answer failed");
    await bot.sendMessage(msg.chat.id, "Сейчас не получилось разобрать ситуацию по базе Greenleaf Coach. Лимит не списан. Попробуй ещё раз чуть позже.");
  }
}

export async function handleJarvisV5Callback(bot: TelegramBot, query: CallbackQuery): Promise<void> {
  await handleJarvisCallback(bot, query);
}
