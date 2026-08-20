import OpenAI from "openai";
import TelegramBot from "node-telegram-bot-api";
import type { CallbackQuery, Message } from "node-telegram-bot-api";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger.js";
import {
  handleJarvisV6Message,
  handleJarvisV6Callback,
  initJarvisV6,
  sanitizeJarvisUserText,
} from "./jarvisV6.js";

const PROXY_BASE_URL = process.env.PROXY_API_BASE_URL || "https://api.proxyapi.ru/openai/v1";
const PROXY_MODEL = process.env.PROXY_API_MODEL || "gpt-4o-mini";
const AI_ENABLED = process.env.AI_ENABLED !== "false";

let client: OpenAI | null = null;

type RefineResult = {
  kind: "clarification" | "answer";
  text: string;
};

type SendMessageArgs = Parameters<TelegramBot["sendMessage"]>;

const SPECULATIVE_THIRD_PARTY_QUESTION_RE = /(?:как\s+ты\s+(?:думаешь|считаешь)|как\s+тебе\s+кажется|думаешь\s*,?\s*(?:он|она)|считаешь\s*,?\s*(?:он|она)|(?:он|она)\s+(?:готов(?:а)?|открыт(?:а)?|захочет|согласится))[^.!?]{0,120}\?/iu;
const META_EXPLANATION_RE = /(?:это\s+поможет\s+(?:понять|прояснить)|так\s+ты\s+пойм[её]шь|это\s+создаст\s+интерес)/iu;

function getClient(): OpenAI | null {
  if (!AI_ENABLED) return null;
  const key = process.env.PROXY_API_KEY || process.env.PROXY_API_TOKEN;
  if (!key) return null;
  if (!client) client = new OpenAI({ apiKey: key, baseURL: PROXY_BASE_URL });
  return client;
}

function shouldSkipAdaptiveRewrite(userText: string, outgoing: string): boolean {
  if (!userText || userText.startsWith("/")) return true;
  if (outgoing.length < 45) return true;
  if (/^(?:🔒|Осталось\s+\d+|Остался\s+\d+|Сейчас не получилось|Что-то пошло не так)/iu.test(outgoing)) return true;
  if (/бесплатн(?:ый|ых|ого)\s+(?:лимит|ответ)/iu.test(outgoing)) return true;
  return false;
}

function needsActionableRepair(text: string): boolean {
  return SPECULATIVE_THIRD_PARTY_QUESTION_RE.test(text);
}

function isInterpersonalWorkCase(userText: string): boolean {
  return /(?:партн[её]р|нович|кандидат|человек|знаком|клиент|переписк|сообщен|ответил|ответила|сказал|сказала|возражен|встреч|созвон)/iu.test(userText);
}

async function refineForConversation(userText: string, draft: string): Promise<RefineResult | null> {
  const c = getClient();
  if (!c) return null;

  try {
    const response = await c.chat.completions.create({
      model: PROXY_MODEL,
      messages: [
        {
          role: "system",
          content: `Ты — финальный редактор Джарвиса, нейропомощника партнёра Greenleaf. Перед тобой уже проверенный, основанный на базе Greenleaf Coach черновик. Твоя задача — НЕ менять его методику и НЕ добавлять новые факты, а превратить его в живой, содержательный ответ сильного наставника.

ГЛАВНАЯ ЗАДАЧА:
Пользователь должен после ответа понимать не только «что вообще правильно», а ЧТО КОНКРЕТНО СДЕЛАТЬ СЕЙЧАС. Джарвис не перекладывает диагностику на пользователя и не заставляет его гадать за другого человека.

ПРАВИЛА:
1. Сохрани всю фактическую и методическую опору исходного draft. Ничего не выдумывай.
2. Если draft по смыслу является уточнением, kind="clarification":
   - коротко объясни, какой информации не хватает и почему она реально меняет решение;
   - задай ПОЛЬЗОВАТЕЛЮ один прямой вопрос;
   - дай 3–6 конкретных вариантов ответа, если это облегчает выбор;
   - обычно 70–140 слов;
   - не пиши «уточни у него», если сначала нужно узнать факт у пользователя.
3. Если данных достаточно и draft — решение, kind="answer":
   - обычно 110–230 слов, но не растягивай простую задачу;
   - коротко объясни, что здесь происходит и почему это важно;
   - скажи, что именно ты бы сделал сейчас;
   - в ситуациях общения с кандидатом, новичком или партнёром, если следующий шаг — разговор/сообщение, ОБЯЗАТЕЛЬНО дай естественную готовую реплику, которую можно реально отправить или сказать без редактирования;
   - после реплики при необходимости дай короткую развилку «если ответит X — делай Y»;
   - заверши КОНКРЕТНЫМ действием: «отправь это», «спроси именно это», «сделай один шаг», «если ответит — пришли ответ, разберём дальше».
4. КАТЕГОРИЧЕСКИ НЕ заканчивай вопросами, где пользователь должен угадать состояние другого человека: «Как думаешь, он открыт?», «Как считаешь, она готова?», «Думаешь, он согласится?». Если это неизвестно — предложи безопасное действие, которое даст реальный ответ.
5. Не заменяй готовую реплику инструкцией «скажи ему что-нибудь вроде...», если можно написать точный человеческий текст.
6. Убирай методические фразы вроде «это поможет прояснить его состояние», если ту же мысль можно сказать живее: «по ответу станет понятно, где он застрял».
7. Если пользователь прямо попросил «короче», «только сообщение», «одной фразой» — уважай это и не увеличивай ответ.
8. Не используй SOURCE, номера источников, внутренние id, названия чанков или служебную разметку.
9. Не используй плейсхолдеры [Имя], [тема], {вставьте...}.
10. Не обещай доход, лечение, гарантии и не добавляй неподтверждённые факты.
11. Пиши естественным русским языком. Допустимы фразы «Здесь я бы сначала...», «Смотри, тут важен один момент...», «Я бы сделал так...». Не начинай каждый ответ одинаково.
12. Не добавляй лишние заголовки ради структуры. Ответ должен ощущаться как личный разбор наставника.

Верни ТОЛЬКО JSON:
{"kind":"clarification"|"answer","text":"финальный текст для пользователя"}`,
        },
        {
          role: "user",
          content: JSON.stringify({
            user_message: userText,
            draft,
            interpersonal_case: isInterpersonalWorkCase(userText),
          }),
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0.24,
      max_tokens: 1200,
    });

    const raw = response.choices[0]?.message?.content || "{}";
    const parsed = JSON.parse(raw) as Partial<RefineResult>;
    if (!parsed.text?.trim()) return null;

    return {
      kind: parsed.kind === "clarification" ? "clarification" : "answer",
      text: sanitizeJarvisUserText(parsed.text.trim()),
    };
  } catch (err) {
    logger.warn({ err }, "Jarvis v7 adaptive response refinement failed; using grounded draft");
    return null;
  }
}

async function repairActionableEnding(userText: string, text: string): Promise<string | null> {
  const c = getClient();
  if (!c) return null;

  try {
    const response = await c.chat.completions.create({
      model: PROXY_MODEL,
      messages: [
        {
          role: "system",
          content: `Ты проверяешь финальный ответ Джарвиса. Методика и факты уже корректны. Исправь ТОЛЬКО способ завершения и практичность ответа.

Обязательные правила:
- не спрашивай пользователя, «как он думает», готов/открыт/согласится ли другой человек;
- не проси пользователя предсказывать чужую реакцию;
- вместо этого дай безопасный конкретный следующий шаг, который позволит увидеть реальную реакцию;
- если речь об общении и уместна реплика, сохрани или добавь полностью готовую естественную фразу для отправки;
- не добавляй новых фактов, цифр или методик;
- не используй SOURCE и плейсхолдеры;
- закончи действием, а не гадательным вопросом.

Верни ТОЛЬКО JSON: {"text":"исправленный ответ"}`,
        },
        {
          role: "user",
          content: JSON.stringify({ user_message: userText, answer: text }),
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0.15,
      max_tokens: 1200,
    });

    const raw = response.choices[0]?.message?.content || "{}";
    const parsed = JSON.parse(raw) as { text?: string };
    const clean = parsed.text ? sanitizeJarvisUserText(parsed.text.trim()) : "";
    return clean || null;
  } catch (err) {
    logger.warn({ err }, "Jarvis actionable-ending repair failed");
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
       ORDER BY id DESC
       LIMIT 1
     )`,
    [userId, text],
  );
}

function createAdaptiveBot(
  bot: TelegramBot,
  userText: string,
  onRefined: (text: string) => void,
): TelegramBot {
  let firstUserReplyHandled = false;

  return new Proxy(bot, {
    get(target, property, receiver) {
      if (property === "sendMessage") {
        return async (...args: SendMessageArgs) => {
          const [chatId, text, options] = args;
          let finalText = text;

          if (!firstUserReplyHandled && !shouldSkipAdaptiveRewrite(userText, text)) {
            firstUserReplyHandled = true;
            const refined = await refineForConversation(userText, text);
            if (refined?.text) {
              finalText = refined.text;

              if (needsActionableRepair(finalText)) {
                const repaired = await repairActionableEnding(userText, finalText);
                if (repaired && !needsActionableRepair(repaired)) {
                  finalText = repaired;
                  logger.info("Jarvis repaired speculative third-party closing question");
                }
              }

              if (META_EXPLANATION_RE.test(finalText) && finalText.length < 80) {
                logger.debug("Jarvis answer contains short meta explanation; retained because content is otherwise valid");
              }

              onRefined(finalText);
              logger.info({ kind: refined.kind }, "Jarvis v7 adapted grounded reply for conversational depth");
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

export async function initJarvisV7(): Promise<void> {
  await initJarvisV6();
  logger.info("Jarvis v7 adaptive-depth + actionable-ending layer ready");
}

export async function handleJarvisV7Message(bot: TelegramBot, msg: Message): Promise<void> {
  const userId = msg.from?.id;
  const userText = msg.text?.trim() || "";
  let refinedText: string | null = null;

  const adaptiveBot = createAdaptiveBot(bot, userText, (text) => {
    refinedText = text;
  });

  await handleJarvisV6Message(adaptiveBot, msg);

  if (userId && refinedText) {
    await updateLatestAssistantHistory(userId, refinedText);
  }
}

export async function handleJarvisV7Callback(bot: TelegramBot, query: CallbackQuery): Promise<void> {
  await handleJarvisV6Callback(bot, query);
}
