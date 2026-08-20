import OpenAI from "openai";
import TelegramBot from "node-telegram-bot-api";
import type { CallbackQuery, Message } from "node-telegram-bot-api";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger.js";
import {
  handleJarvisV7Message,
  handleJarvisV7Callback,
  initJarvisV7,
} from "./jarvisV7.js";
import { handleJarvisV6Message, sanitizeJarvisUserText } from "./jarvisV6.js";
import { renderRagContext, retrieveJarvisRag } from "./rag/jarvisRag.js";

const PROXY_BASE_URL = process.env.PROXY_API_BASE_URL || "https://api.proxyapi.ru/openai/v1";
const PROXY_MODEL = process.env.PROXY_API_MODEL || "gpt-4o-mini";
const AI_ENABLED = process.env.AI_ENABLED !== "false";
const FREE_ANSWER_LIMIT = 20;
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const APP_URL = process.env.JARVIS_APP_URL || "https://greenleaf-coach.replit.app";
const TIME_ZONE = process.env.JARVIS_TIME_ZONE || "Europe/Moscow";

let client: OpenAI | null = null;

type SendMessageArgs = Parameters<TelegramBot["sendMessage"]>;

type FinalMentorResult = {
  mode: "ask_user" | "diagnostic_message" | "solution";
  text: string;
};

type LatestAssistantState = {
  id: string;
  counted: boolean;
  message_type: string;
};

type FinalQuotaDecision = {
  allowed: boolean;
  newlyCounted: boolean;
  alreadyCounted: boolean;
  remaining: number;
  lockedUntil: Date | null;
};

const INTERPERSONAL_RE = /(?:партн[её]р|нович|кандидат|человек|знаком|клиент|переписк|сообщен|ответил|ответила|сказал|сказала|возражен|встреч|созвон|коллег)/iu;
const WHAT_TO_DO_RE = /(?:что\s+(?:мне\s+)?делать|как\s+(?:мне\s+)?(?:поступить|помочь|ответить|написать|поговорить|продолжить)|что\s+(?:ему|ей)\s+(?:сказать|написать))/iu;
const USER_WANTS_SHORT_RE = /(?:короче|кратко|только\s+(?:сообщение|текст|ответ)|одной\s+фразой|без\s+объяснений)/iu;
const READY_PHRASE_RE = /(?:«[^»]{12,}»|"[^"\n]{12,}"|я\s+бы\s+(?:написал|сказал)\s+так\s*:)/iu;
const DIDACTIC_RE = /(?:^|[.!?]\s+)(?:спроси|уточни|предложи|попроси)\s+(?:новичка|партн[её]ра|кандидата|его|её)|на\s+основе\s+(?:его|её)\s+ответа|это\s+поможет\s+(?:понять|прояснить)/iu;
const SPECULATIVE_RE = /(?:как\s+ты\s+(?:думаешь|считаешь)|как\s+тебе\s+кажется|(?:он|она)\s+(?:готов(?:а)?|открыт(?:а)?|захочет|согласится))[^.!?]{0,120}\?/iu;
const PLACEHOLDER_RE = /\[[^\]]{1,80}\]|\{[^}]{1,80}\}|<[^>]{1,80}>|\b(?:ваша\s+сфера|ваше\s+имя|имя\s+собеседника|вставьте\s+(?:сюда|имя|тему))\b/iu;
const SOURCE_RE = /(?:\(?\[?SOURCE\s*\d+(?:\s*[:#-]\s*[A-Za-z0-9_.:-]+)?\]?\)?)/giu;
const ZERO_ACTION_RE = /(?:никому\s+(?:ещ[её]\s+)?не\s+(?:написал|написала)|ничего\s+не\s+делает|только\s+(?:читает|изучает)|застрял|завис|перегруз|боится\s+(?:писать|отказов)|не\s+знает\s*,?\s+с\s+чего\s+начать)/iu;
const CAUSE_SIGNAL_RE = /(?:боится|страх|неуверен|не\s+уверен|не\s+понимает|не\s+знает\s*,?\s+с\s+чего|получил[а]?\s+[^.!?]{0,50}отказ|после\s+[^.!?]{0,50}отказ|нет\s+времени|нет\s+денег|дорого|пирамид|неинтерес|не\s+интерес|не\s+получается|перегруз|устал|выгорел|сдулся|стесняется|не\s+хочет)/iu;
const TOO_BIG_FIRST_STEP_RE = /(?:напис(?:ать|и)\s+(?:сразу\s+)?(?:тр[её]м|3|нескольким|пяти|5|десяти|10)\s+(?:людям|человекам)|сделай\s+\d+\s+(?:сообщений|контактов))/iu;
const PREMATURE_ACTION_RE = /(?:состав(?:ить|ь)\s+(?:список|\d+\s+(?:им[её]н|контактов))|напис(?:ать|и)\s+(?:одному|человеку|людям)|сделать\s+первый\s+шаг|выбрать\s+(?:один\s+)?шаг|позвон(?:ить|и)|назнач(?:ить|ь)\s+(?:встречу|созвон))/iu;
const HR_DRIFT_RE = /(?:заработн(?:ая|ой)\s+плат|ваканси|в\s+этой\s+позици|позици[яю]\s+или\s+компани|работодатель|собеседовани)/iu;
const WARM_FORMER_COLLEAGUE_RE = /(?:бывш(?:ая|ей|ую)?\s+коллег|коллег(?:а|ой|у)).{0,100}(?:давно|год|лет|не\s+общ)|(?:давно|год|лет|не\s+общ).{0,100}(?:бывш(?:ая|ей|ую)?\s+коллег|коллег(?:а|ой|у))/iu;
const READY_MESSAGE_REQUEST_RE = /(?:как\s+написать|что\s+написать|напиши\s+(?:сообщение|ответ)|без\s+резкого\s+захода)/iu;
const MULTI_PRICE_PYRAMID_RE = /(?=.*(?:дорог|цен|сумм))(?=.*пирамид)/iu;
const PYRAMID_COVERAGE_RE = /(?:пирамид|модел|систем|структур|продукт|товарооборот|реальн(?:ый|ого)\s+товар)/iu;
const UNSAFE_MEDICAL_RE = /(?:вылеч|лечит|излеч|гарантир.*здоров|точно\s+поможет.*(?:болез|проблем))/iu;
const FACT_NO_DATA_RE = /(?:точн|официальн).*(?:выручк|оборот|отч[её]т|статистик|цифр)/iu;

function getClient(): OpenAI | null {
  if (!AI_ENABLED) return null;
  const key = process.env.PROXY_API_KEY || process.env.PROXY_API_TOKEN;
  if (!key) return null;
  if (!client) client = new OpenAI({ apiKey: key, baseURL: PROXY_BASE_URL });
  return client;
}

function isInterpersonal(userText: string): boolean {
  return INTERPERSONAL_RE.test(userText);
}

function diagnosticFirstRequired(userText: string): boolean {
  return isInterpersonal(userText)
    && WHAT_TO_DO_RE.test(userText)
    && ZERO_ACTION_RE.test(userText)
    && !CAUSE_SIGNAL_RE.test(userText);
}

function warmContextAlreadySufficient(userText: string): boolean {
  return WARM_FORMER_COLLEAGUE_RE.test(userText) && READY_MESSAGE_REQUEST_RE.test(userText);
}

function shouldSkip(userText: string, outgoing: string): boolean {
  if (!userText || userText.startsWith("/")) return true;
  if (USER_WANTS_SHORT_RE.test(userText)) return true;
  if (outgoing.length < 35) return true;
  if (/^(?:🔒|Осталось\s+\d+|Остался\s+\d+|Сейчас не получилось|Что-то пошло не так)/iu.test(outgoing)) return true;
  if (/бесплатн(?:ый|ых|ого)\s+(?:лимит|ответ)/iu.test(outgoing)) return true;
  if (/приятно\s+познакомиться|рад\s+знакомству/iu.test(outgoing)) return true;
  return false;
}

async function recentHistory(userId: number, limit = 10): Promise<Array<{ role: string; content: string }>> {
  const result = await pool.query<{ role: string; content: string }>(
    `SELECT role, content FROM (
       SELECT id, role, content FROM jarvis_messages
       WHERE telegram_user_id = $1 AND role IN ('user','assistant')
       ORDER BY id DESC LIMIT $2
     ) h ORDER BY id ASC`,
    [userId, limit],
  );
  return result.rows;
}

async function latestAssistantState(userId: number): Promise<LatestAssistantState | null> {
  const result = await pool.query<LatestAssistantState>(
    `SELECT id::text, counted, message_type
     FROM jarvis_messages
     WHERE telegram_user_id=$1 AND role='assistant'
     ORDER BY id DESC LIMIT 1`,
    [userId],
  );
  return result.rows[0] || null;
}

function cleanOutput(text: string): string {
  return sanitizeJarvisUserText(text)
    .replace(SOURCE_RE, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\n\s+/g, "\n")
    .trim();
}

function needsRepair(userText: string, mode: FinalMentorResult["mode"], text: string): boolean {
  if (PLACEHOLDER_RE.test(text) || SPECULATIVE_RE.test(text) || HR_DRIFT_RE.test(text)) return true;
  if (DIDACTIC_RE.test(text) && !READY_PHRASE_RE.test(text)) return true;
  if (isInterpersonal(userText) && WHAT_TO_DO_RE.test(userText) && text.length < 500 && !READY_PHRASE_RE.test(text)) return true;
  if (ZERO_ACTION_RE.test(userText) && TOO_BIG_FIRST_STEP_RE.test(text)) return true;
  if (warmContextAlreadySufficient(userText) && mode === "ask_user") return true;
  if (MULTI_PRICE_PYRAMID_RE.test(userText) && !PYRAMID_COVERAGE_RE.test(text)) return true;
  if (UNSAFE_MEDICAL_RE.test(userText) && /может\s+помочь\s+(?:вам|тебе)?\s*(?:в|с)?\s*(?:решени|лечени)|вылеч|излеч/iu.test(text)) return true;

  if (diagnosticFirstRequired(userText)) {
    if (mode !== "diagnostic_message") return true;
    if (!READY_PHRASE_RE.test(text)) return true;
    if (PREMATURE_ACTION_RE.test(text)) return true;
  }

  return false;
}

function deterministicDiagnosticFallback(): string {
  return `По описанию видно одно: человек пока не перешёл от изучения к действию. Но почему именно — мы ещё не знаем. Поэтому я бы не назначал ему задачу наугад и не давал ещё больше информации.\n\nЯ бы написал так:\n\n«Слушай, вижу, что ты серьёзно изучаешь материалы. Хочу понять без давления: тебе сейчас просто нужно ещё немного времени разобраться или информации уже стало много и пока непонятно, с чего лучше начать? Если что-то тормозит — скажи как есть, разберём спокойно».\n\nПока не предлагай ему писать людям или составлять списки. Сначала дождись ответа — тогда будет понятно, нужен ему маленький первый шаг, помощь со страхом или просто время. Пришли его ответ сюда, и разберём дальше.`;
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

async function profileName(userId: number): Promise<string> {
  const result = await pool.query<{ preferred_name: string | null }>(
    `SELECT preferred_name FROM jarvis_profiles WHERE telegram_user_id=$1`,
    [userId],
  );
  return result.rows[0]?.preferred_name || "друг";
}

async function sendLockedDirect(target: TelegramBot, chatId: number, userId: number, lockedUntil: Date | null): Promise<void> {
  const name = await profileName(userId);
  const until = lockedUntil || new Date(Date.now() + WINDOW_MS);
  await target.sendMessage(
    chatId,
    `🔒 ${name}, бесплатный лимит Джарвиса на этот период закончился.\n\nСледующие 20 полноценных ответов станут доступны ${formatDateTime(until)}.\n\nИли можно продолжить этот разбор в Greenleaf Coach.`,
    { reply_markup: { inline_keyboard: [[{ text: "Продолжить этот разбор в Greenleaf Coach →", url: APP_URL }]] } },
  );
}

async function reserveFinalVisibleAnswer(userId: number): Promise<FinalQuotaDecision> {
  const latest = await latestAssistantState(userId);
  if (!latest) {
    return { allowed: true, newlyCounted: false, alreadyCounted: false, remaining: FREE_ANSWER_LIMIT, lockedUntil: null };
  }

  if (latest.counted) {
    const usage = await pool.query<{ answers_used: number; locked_until: Date | null }>(
      `SELECT answers_used, locked_until FROM jarvis_usage WHERE telegram_user_id=$1`,
      [userId],
    );
    const row = usage.rows[0];
    return {
      allowed: true,
      newlyCounted: false,
      alreadyCounted: true,
      remaining: Math.max(0, FREE_ANSWER_LIMIT - Number(row?.answers_used || 0)),
      lockedUntil: row?.locked_until ? new Date(row.locked_until) : null,
    };
  }

  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");
    await connection.query(
      `INSERT INTO jarvis_usage (telegram_user_id) VALUES ($1)
       ON CONFLICT (telegram_user_id) DO NOTHING`,
      [userId],
    );
    const selected = await connection.query<{
      answers_used: number;
      window_started_at: Date | null;
      locked_until: Date | null;
    }>(
      `SELECT answers_used, window_started_at, locked_until
       FROM jarvis_usage WHERE telegram_user_id=$1 FOR UPDATE`,
      [userId],
    );
    const row = selected.rows[0];
    const now = new Date();
    const previousStart = row.window_started_at ? new Date(row.window_started_at) : null;
    const expired = !!previousStart && now.getTime() >= previousStart.getTime() + WINDOW_MS;
    const used = expired ? 0 : Number(row.answers_used || 0);
    const windowStart = expired || !previousStart ? now : previousStart;

    if (used >= FREE_ANSWER_LIMIT) {
      const lockedUntil = new Date(windowStart.getTime() + WINDOW_MS);
      await connection.query(
        `UPDATE jarvis_usage SET locked_until=$2, updated_at=NOW() WHERE telegram_user_id=$1`,
        [userId, lockedUntil],
      );
      await connection.query("COMMIT");
      return { allowed: false, newlyCounted: false, alreadyCounted: false, remaining: 0, lockedUntil };
    }

    const nextUsed = used + 1;
    const lockedUntil = nextUsed >= FREE_ANSWER_LIMIT ? new Date(windowStart.getTime() + WINDOW_MS) : null;
    await connection.query(
      `UPDATE jarvis_usage
       SET answers_used=$2, window_started_at=$3, locked_until=$4, updated_at=NOW()
       WHERE telegram_user_id=$1`,
      [userId, nextUsed, windowStart, lockedUntil],
    );
    await connection.query(
      `UPDATE jarvis_messages SET counted=TRUE, message_type='answer'
       WHERE id=$1::bigint`,
      [latest.id],
    );
    await connection.query("COMMIT");
    return {
      allowed: true,
      newlyCounted: true,
      alreadyCounted: false,
      remaining: Math.max(0, FREE_ANSWER_LIMIT - nextUsed),
      lockedUntil,
    };
  } catch (err) {
    await connection.query("ROLLBACK");
    throw err;
  } finally {
    connection.release();
  }
}

async function synthesizeFinalMentorReply(
  userId: number,
  userText: string,
  v7Text: string,
): Promise<FinalMentorResult | null> {
  const c = getClient();
  if (!c) return null;

  try {
    const history = await recentHistory(userId, 10);
    const mustDiagnoseFirst = diagnosticFirstRequired(userText);
    const warmReady = warmContextAlreadySufficient(userText);
    const retrievalQuery = `${history.map((item) => item.content).join("\n")}\n${userText}\n${v7Text}`;
    const hits = await retrieveJarvisRag(retrievalQuery, 6);
    const rag = renderRagContext(hits);

    const response = await c.chat.completions.create({
      model: PROXY_MODEL,
      messages: [
        {
          role: "system",
          content: `Ты — финальный наставнический слой Джарвиса. До тебя ответ уже прошёл RAG и несколько проверок. Сделай финальную версию максимально полезной партнёру Greenleaf, строго на основе SOURCE и существующего ответа. Не добавляй факты из общей памяти модели.

КЛЮЧЕВОЕ РАЗЛИЧИЕ:
A) Если не хватает факта, который пользователь УЖЕ МОЖЕТ ЗНАТЬ (кто человек, что написал дословно, давно ли знакомы) — mode="ask_user". Один вопрос, при необходимости варианты.
B) Если факт можно узнать только у другого человека (чего боится, почему завис, что реально смущает) — mode="diagnostic_message". Дай готовую естественную реплику для отправки, а не инструкцию «спроси его».
C) Если данных достаточно — mode="solution": разбор + конкретное действие + готовая реплика, если нужен разговор.

ВАЖНЫЕ РЕЛИЗНЫЕ ПРАВИЛА:
- Если warm_context_sufficient=true, НЕ спрашивай стиль «дружески/официально/нейтрально». Контекста уже достаточно: дай готовое сообщение.
- Если пользователь дал ДВА возражения (например «дорого» И «пирамида»), нельзя молча потерять одно. Либо коротко учти оба, либо мягко уточни, какое из двух является главным, явно назвав оба.
- Greenleaf — не вакансия. Не используй «заработная плата», «позиция», «работодатель», «собеседование», если пользователь сам не говорит о найме.
- Для точных текущих фактов, которых нет в подтверждённом SOURCE, прямо скажи: «В моей подтверждённой базе Greenleaf нет данных, чтобы назвать это точно». Не выдумывай отдел инвесторов, отчёт или ссылку.
- Если пользователь просит гарантировать лечение или доход, прямо откажись от гарантии. Не заменяй это фразой, что продукт «может помочь решить проблему», если медицинское основание не подтверждено.

DIAGNOSTIC-FIRST:
Если diagnostic_first_required=true, причина бездействия НЕ ИЗВЕСТНА. mode="diagnostic_message" обязателен. Нельзя назначать список контактов, писать людям, созвон или встречу до ответа человека.

СТАНДАРТ:
- отделяй факт от гипотезы;
- живой наставник, не HR и не методичка;
- готовый текст без плейсхолдеров;
- один логичный следующий шаг;
- не используй SOURCE в пользовательском тексте;
- не обещай доход, лечение, гарантии;
- сложный кейс обычно 120–220 слов, простой — короче.

SOURCE-ФРАГМЕНТЫ:
${rag}

Верни ТОЛЬКО JSON:
{"mode":"ask_user"|"diagnostic_message"|"solution","text":"чистый финальный ответ пользователю"}`,
        },
        {
          role: "user",
          content: JSON.stringify({
            current_user_message: userText,
            current_v7_answer: v7Text,
            recent_context: history.slice(-8),
            user_asks_what_to_do: WHAT_TO_DO_RE.test(userText),
            zero_action_or_overload: ZERO_ACTION_RE.test(userText),
            diagnostic_first_required: mustDiagnoseFirst,
            warm_context_sufficient: warmReady,
            combined_price_pyramid: MULTI_PRICE_PYRAMID_RE.test(userText),
            exact_fact_without_confirmed_source_must_be_admitted: FACT_NO_DATA_RE.test(userText),
          }),
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0.1,
      max_tokens: 1300,
    });

    const raw = response.choices[0]?.message?.content || "{}";
    const parsed = JSON.parse(raw) as Partial<FinalMentorResult>;
    const text = typeof parsed.text === "string" ? cleanOutput(parsed.text) : "";
    if (!text) return null;
    const mode: FinalMentorResult["mode"] = parsed.mode === "ask_user"
      ? "ask_user"
      : parsed.mode === "diagnostic_message"
        ? "diagnostic_message"
        : "solution";
    return { mode, text };
  } catch (err) {
    logger.warn({ err }, "Jarvis v8 final mentor synthesis failed; using v7 answer");
    return null;
  }
}

async function repairFinalMentorReply(
  userText: string,
  mode: FinalMentorResult["mode"],
  text: string,
): Promise<FinalMentorResult | null> {
  const c = getClient();
  if (!c) return null;

  try {
    const mustDiagnoseFirst = diagnosticFirstRequired(userText);
    const warmReady = warmContextAlreadySufficient(userText);
    const hits = await retrieveJarvisRag(`${userText}\n${text}`, 5);
    const response = await c.chat.completions.create({
      model: PROXY_MODEL,
      messages: [
        {
          role: "system",
          content: `Исправь финальный ответ Джарвиса, не меняя подтверждённые факты и методику SOURCE.

Обязательно исправь, если есть:
- HR-язык («заработная плата», «позиция», «работодатель», «собеседование») при разговоре о Greenleaf;
- потеря одного из нескольких возражений пользователя;
- лишнее уточнение стиля, когда уже известно, что это бывший коллега/знакомый и пользователь просит готовое сообщение;
- неподтверждённый точный факт или придуманная ссылка/отдел;
- медицинское или доходное обещание.

Если diagnostic_first_required=true: mode=diagnostic_message, готовая мягкая диагностика, без рабочего шага до ответа.
Если warm_context_sufficient=true: mode=solution и готовое сообщение; не спрашивай «дружески/официально/нейтрально».
Если combined_price_pyramid=true: явно сохрани оба аспекта — цена и сомнение в модели/«пирамиде».

Нельзя SOURCE, плейсхолдеры, гадание о чужой готовности.

SOURCE:
${renderRagContext(hits)}

Верни ТОЛЬКО JSON: {"mode":"ask_user"|"diagnostic_message"|"solution","text":"исправленный ответ"}`,
        },
        {
          role: "user",
          content: JSON.stringify({
            user_message: userText,
            previous_mode: mode,
            answer: text,
            diagnostic_first_required: mustDiagnoseFirst,
            warm_context_sufficient: warmReady,
            combined_price_pyramid: MULTI_PRICE_PYRAMID_RE.test(userText),
          }),
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0.04,
      max_tokens: 1300,
    });

    const raw = response.choices[0]?.message?.content || "{}";
    const parsed = JSON.parse(raw) as Partial<FinalMentorResult>;
    const clean = typeof parsed.text === "string" ? cleanOutput(parsed.text) : "";
    if (!clean) return null;
    const repairedMode: FinalMentorResult["mode"] = parsed.mode === "ask_user"
      ? "ask_user"
      : parsed.mode === "diagnostic_message"
        ? "diagnostic_message"
        : "solution";
    return { mode: repairedMode, text: clean };
  } catch (err) {
    logger.warn({ err }, "Jarvis v8 final repair failed");
    return null;
  }
}

async function updateLatestAssistantHistory(userId: number, text: string): Promise<void> {
  await pool.query(
    `UPDATE jarvis_messages
     SET content = $2
     WHERE id = (
       SELECT id FROM jarvis_messages
       WHERE telegram_user_id = $1 AND role = 'assistant'
       ORDER BY id DESC LIMIT 1
     )`,
    [userId, text],
  );
}

function createV8Bot(
  bot: TelegramBot,
  userId: number,
  userText: string,
  onFinal: (text: string) => void,
): TelegramBot {
  let firstSubstantiveReplyHandled = false;

  return new Proxy(bot, {
    get(target, property, receiver) {
      if (property === "sendMessage") {
        return async (...args: SendMessageArgs) => {
          const [chatId, text, options] = args;
          let finalText = text;

          if (!firstSubstantiveReplyHandled && !shouldSkip(userText, text)) {
            firstSubstantiveReplyHandled = true;
            const synthesized = await synthesizeFinalMentorReply(userId, userText, text);
            if (synthesized?.text) {
              let finalResult: FinalMentorResult = synthesized;

              if (needsRepair(userText, finalResult.mode, finalResult.text)) {
                const repaired = await repairFinalMentorReply(userText, finalResult.mode, finalResult.text);
                if (repaired) finalResult = repaired;
              }

              if (needsRepair(userText, finalResult.mode, finalResult.text) && diagnosticFirstRequired(userText)) {
                finalResult = {
                  mode: "diagnostic_message",
                  text: deterministicDiagnosticFallback(),
                };
                logger.warn("Jarvis v8 used deterministic diagnostic-first fallback");
              }

              const latest = await latestAssistantState(userId);
              if (latest?.counted && finalResult.mode === "ask_user") {
                // The core already spent a slot; never turn a paid answer into a bare clarification.
                finalResult = { mode: "solution", text: cleanOutput(text) };
              }

              if (finalResult.mode !== "ask_user") {
                const quota = await reserveFinalVisibleAnswer(userId);
                if (!quota.allowed) {
                  await sendLockedDirect(target, chatId, userId, quota.lockedUntil);
                  logger.warn({ userId }, "Jarvis v8 blocked final answer because quota slot was unavailable");
                  return { message_id: 0, chat: { id: chatId }, date: Math.floor(Date.now() / 1000) } as any;
                }

                finalText = cleanOutput(finalResult.text);
                onFinal(finalText);
                const sent = await target.sendMessage(chatId, finalText, options);

                // v5 already emits warnings for answers it counted itself. Emit them only when v8 upgraded a free clarification.
                if (quota.newlyCounted) {
                  if (quota.remaining === 5) {
                    await target.sendMessage(chatId, "Осталось 5 бесплатных полноценных ответов Джарвиса. Наводящие вопросы лимит не расходуют.");
                  } else if (quota.remaining === 1) {
                    await target.sendMessage(chatId, "Остался 1 бесплатный полноценный ответ Джарвиса в текущем 7-дневном периоде.");
                  } else if (quota.remaining === 0) {
                    await sendLockedDirect(target, chatId, userId, quota.lockedUntil);
                  }
                }

                logger.info({
                  mode: finalResult.mode,
                  diagnosticFirst: diagnosticFirstRequired(userText),
                  quotaReconciled: quota.newlyCounted,
                }, "Jarvis v8 final grounded mentor layer applied");
                return sent;
              }

              finalText = cleanOutput(finalResult.text);
              onFinal(finalText);
              logger.info({
                mode: finalResult.mode,
                diagnosticFirst: diagnosticFirstRequired(userText),
                quotaReconciled: false,
              }, "Jarvis v8 final grounded mentor layer applied");
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

export async function initJarvisV8(): Promise<void> {
  await initJarvisV7();
  logger.info("Jarvis v8 atomic-quota + release-quality layer ready");
}

export async function handleJarvisV8Message(bot: TelegramBot, msg: Message): Promise<void> {
  const userId = msg.from?.id;
  const userText = msg.text?.trim() || "";
  if (!userId) {
    await handleJarvisV7Message(bot, msg);
    return;
  }

  // Preserve deterministic onboarding/name flow. Do not let mentor rewrite the user's name handshake.
  if (userText && !userText.startsWith("/")) {
    const profile = await pool.query<{ preferred_name: string | null }>(
      `SELECT preferred_name FROM jarvis_profiles WHERE telegram_user_id=$1`,
      [userId],
    );
    if (!profile.rows[0]?.preferred_name) {
      await handleJarvisV6Message(bot, msg);
      return;
    }
  }

  const lockConnection = await pool.connect();
  try {
    // Serialize complete AI requests per Telegram user. This prevents two concurrent requests from both consuming/sending the 20th slot.
    await lockConnection.query(`SELECT pg_advisory_lock($1::bigint)`, [userId]);

    let finalText: string | null = null;
    const v8Bot = createV8Bot(bot, userId, userText, (text) => {
      finalText = text;
    });

    await handleJarvisV7Message(v8Bot, msg);

    if (finalText) {
      await updateLatestAssistantHistory(userId, finalText);
    }
  } finally {
    try { await lockConnection.query(`SELECT pg_advisory_unlock($1::bigint)`, [userId]); } catch {}
    lockConnection.release();
  }
}

export async function handleJarvisV8Callback(bot: TelegramBot, query: CallbackQuery): Promise<void> {
  await handleJarvisV7Callback(bot, query);
}
