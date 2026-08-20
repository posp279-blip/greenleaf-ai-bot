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
import { sanitizeJarvisUserText } from "./jarvisV6.js";
import { renderRagContext, retrieveJarvisRag } from "./rag/jarvisRag.js";

const PROXY_BASE_URL = process.env.PROXY_API_BASE_URL || "https://api.proxyapi.ru/openai/v1";
const PROXY_MODEL = process.env.PROXY_API_MODEL || "gpt-4o-mini";
const AI_ENABLED = process.env.AI_ENABLED !== "false";

let client: OpenAI | null = null;

type SendMessageArgs = Parameters<TelegramBot["sendMessage"]>;

type FinalMentorResult = {
  mode: "ask_user" | "diagnostic_message" | "solution";
  text: string;
};

const INTERPERSONAL_RE = /(?:партн[её]р|нович|кандидат|человек|знаком|клиент|переписк|сообщен|ответил|ответила|сказал|сказала|возражен|встреч|созвон)/iu;
const WHAT_TO_DO_RE = /(?:что\s+(?:мне\s+)?делать|как\s+(?:мне\s+)?(?:поступить|помочь|ответить|написать|поговорить|продолжить)|что\s+(?:ему|ей)\s+(?:сказать|написать))/iu;
const USER_WANTS_SHORT_RE = /(?:короче|кратко|только\s+(?:сообщение|текст|ответ)|одной\s+фразой|без\s+объяснений)/iu;
const READY_PHRASE_RE = /(?:«[^»]{12,}»|"[^"\n]{12,}"|я\s+бы\s+(?:написал|сказал)\s+так\s*:)/iu;
const DIDACTIC_RE = /(?:^|[.!?]\s+)(?:спроси|уточни|предложи|попроси)\s+(?:новичка|партн[её]ра|кандидата|его|её)|на\s+основе\s+(?:его|её)\s+ответа|это\s+поможет\s+(?:понять|прояснить)/iu;
const SPECULATIVE_RE = /(?:как\s+ты\s+(?:думаешь|считаешь)|как\s+тебе\s+кажется|(?:он|она)\s+(?:готов(?:а)?|открыт(?:а)?|захочет|согласится))[^.!?]{0,120}\?/iu;
const PLACEHOLDER_RE = /\[[^\]]{1,80}\]|\{[^}]{1,80}\}|<[^>]{1,80}>|\b(?:ваша\s+сфера|ваше\s+имя|имя\s+собеседника|вставьте\s+(?:сюда|имя|тему))\b/iu;
const SOURCE_RE = /(?:\(?\[?SOURCE\s*\d+(?:\s*[:#-]\s*[A-Za-z0-9_.:-]+)?\]?\)?)/giu;
const ZERO_ACTION_RE = /(?:никому\s+(?:ещ[её]\s+)?не\s+(?:написал|написала)|ничего\s+не\s+делает|только\s+(?:читает|изучает)|застрял|завис|перегруз|боится\s+(?:писать|отказов)|не\s+знает\s*,?\s+с\s+чего\s+начать)/iu;
const TOO_BIG_FIRST_STEP_RE = /(?:напис(?:ать|и)\s+(?:сразу\s+)?(?:тр[её]м|3|нескольким|пяти|5|десяти|10)\s+(?:людям|человекам)|сделай\s+\d+\s+(?:сообщений|контактов))/iu;

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

function shouldSkip(userText: string, outgoing: string): boolean {
  if (!userText || userText.startsWith("/")) return true;
  if (!isInterpersonal(userText)) return true;
  if (USER_WANTS_SHORT_RE.test(userText)) return true;
  if (outgoing.length < 35) return true;
  if (/^(?:🔒|Осталось\s+\d+|Остался\s+\d+|Сейчас не получилось|Что-то пошло не так)/iu.test(outgoing)) return true;
  if (/бесплатн(?:ый|ых|ого)\s+(?:лимит|ответ)/iu.test(outgoing)) return true;
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

function cleanOutput(text: string): string {
  return sanitizeJarvisUserText(text)
    .replace(SOURCE_RE, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\n\s+/g, "\n")
    .trim();
}

function needsRepair(userText: string, text: string): boolean {
  if (PLACEHOLDER_RE.test(text) || SPECULATIVE_RE.test(text)) return true;
  if (DIDACTIC_RE.test(text) && !READY_PHRASE_RE.test(text)) return true;
  if (WHAT_TO_DO_RE.test(userText) && text.length < 500 && !READY_PHRASE_RE.test(text)) return true;
  if (ZERO_ACTION_RE.test(userText) && TOO_BIG_FIRST_STEP_RE.test(text)) return true;
  return false;
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
    const retrievalQuery = `${history.map((item) => item.content).join("\n")}\n${userText}\n${v7Text}`;
    const hits = await retrieveJarvisRag(retrievalQuery, 6);
    const rag = renderRagContext(hits);

    const response = await c.chat.completions.create({
      model: PROXY_MODEL,
      messages: [
        {
          role: "system",
          content: `Ты — финальный наставнический слой Джарвиса. До тебя ответ уже прошёл RAG и несколько проверок. Твоя задача — сделать последнюю версию максимально полезной в реальной работе партнёра Greenleaf, строго на основе переданных SOURCE-фрагментов и существующего ответа. Никаких новых фактов из общей памяти модели.

КЛЮЧЕВОЕ РАЗЛИЧИЕ, КОТОРОЕ ТЫ ОБЯЗАН ПРИМЕНЯТЬ:
A) Если для решения не хватает факта, КОТОРЫЙ ПОЛЬЗОВАТЕЛЬ УЖЕ МОЖЕТ ЗНАТЬ (например: кто этот человек ему, что тот написал дословно, давно ли знакомы) — mode="ask_user". Спроси пользователя один раз и дай варианты.
B) Если не хватает факта, КОТОРЫЙ МОЖНО УЗНАТЬ ТОЛЬКО У ДРУГОГО ЧЕЛОВЕКА (например: чего боится новичок, почему партнёр завис, что реально смущает кандидата) — НЕ говори пользователю «спроси его...». Это уже действие. mode="diagnostic_message": коротко объясни ситуацию и ДАЙ ГОТОВУЮ ЕСТЕСТВЕННУЮ РЕПЛИКУ, которую пользователь может сразу отправить этому человеку, чтобы безопасно выяснить причину. Затем скажи, что делать после его ответа.
C) Если данных уже достаточно — mode="solution": дай нормальный разбор, конкретное действие и, если следующий шаг связан с общением, готовую реплику.

СТАНДАРТ 10/10:
- звучит как сильный живой наставник, а не методичка;
- сначала 1–3 предложения по сути: что здесь происходит и почему именно этот шаг логичен;
- затем «Я бы сделал так» / естественный эквивалент;
- если нужен разговор — готовый текст в кавычках, без плейсхолдеров и без выдуманных деталей;
- если человек пока вообще не действует/перегружен/боится — только ОДИН маленький безопасный первый шаг; не требуй сразу писать 3–10 людям;
- не заканчивай «как думаешь, он готов?». Заканчивай конкретным действием или «пришли его ответ — разберём дальше»;
- не пиши «это поможет прояснить его состояние», если можно сказать живее;
- не используй SOURCE в пользовательском тексте;
- не обещай доход, лечение, гарантии и не придумывай факты компании;
- для сложного кейса обычно 120–220 слов; если задача проста — короче.

ВАЖНО: текущий ответ v7 может быть слишком коротким или ошибочно выглядеть как clarification. Не сохраняй эту форму механически. Определи режим по правилам A/B/C выше.

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
          }),
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0.16,
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
  text: string,
): Promise<string | null> {
  const c = getClient();
  if (!c) return null;

  try {
    const hits = await retrieveJarvisRag(`${userText}\n${text}`, 5);
    const response = await c.chat.completions.create({
      model: PROXY_MODEL,
      messages: [
        {
          role: "system",
          content: `Исправь финальный ответ Джарвиса, не меняя факты и методику SOURCE.

Нельзя:
- начинать с сухого «Спроси новичка/партнёра/кандидата...» без готовой реплики;
- заставлять пользователя самому конструировать диагностический вопрос;
- спрашивать, как пользователь думает, готов ли другой человек;
- использовать SOURCE или плейсхолдеры;
- предлагать несколько контактов сразу человеку, который ещё вообще не действует.

Нужно:
- короткий живой диагноз;
- если надо выяснить причину у третьего лица — готовое диагностическое сообщение в кавычках;
- один маленький следующий шаг;
- конкретный финал.

SOURCE:
${renderRagContext(hits)}

Верни ТОЛЬКО JSON: {"text":"исправленный ответ"}`,
        },
        { role: "user", content: JSON.stringify({ user_message: userText, answer: text }) },
      ],
      response_format: { type: "json_object" },
      temperature: 0.08,
      max_tokens: 1300,
    });

    const raw = response.choices[0]?.message?.content || "{}";
    const parsed = JSON.parse(raw) as { text?: string };
    const clean = parsed.text ? cleanOutput(parsed.text) : "";
    return clean || null;
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
              finalText = synthesized.text;

              if (needsRepair(userText, finalText)) {
                const repaired = await repairFinalMentorReply(userText, finalText);
                if (repaired) finalText = repaired;
              }

              finalText = cleanOutput(finalText);
              onFinal(finalText);
              logger.info({ mode: synthesized.mode }, "Jarvis v8 final grounded mentor layer applied");
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
  logger.info("Jarvis v8 final-grounded mentor layer ready");
}

export async function handleJarvisV8Message(bot: TelegramBot, msg: Message): Promise<void> {
  const userId = msg.from?.id;
  const userText = msg.text?.trim() || "";
  if (!userId) {
    await handleJarvisV7Message(bot, msg);
    return;
  }

  let finalText: string | null = null;
  const v8Bot = createV8Bot(bot, userId, userText, (text) => {
    finalText = text;
  });

  await handleJarvisV7Message(v8Bot, msg);

  if (finalText) {
    await updateLatestAssistantHistory(userId, finalText);
  }
}

export async function handleJarvisV8Callback(bot: TelegramBot, query: CallbackQuery): Promise<void> {
  await handleJarvisV7Callback(bot, query);
}
