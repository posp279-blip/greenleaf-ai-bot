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

async function refineForConversation(userText: string, draft: string): Promise<RefineResult | null> {
  const c = getClient();
  if (!c) return null;

  try {
    const response = await c.chat.completions.create({
      model: PROXY_MODEL,
      messages: [
        {
          role: "system",
          content: `Ты — финальный редактор Джарвиса, нейропомощника партнёра Greenleaf. Перед тобой уже проверенный, основанный на базе Greenleaf Coach черновик. Твоя задача — НЕ менять его методику и НЕ добавлять новые факты, а превратить его в живой, содержательный ответ наставника.

ГЛАВНАЯ ПРОБЛЕМА, КОТОРУЮ ТЫ ИСПРАВЛЯЕШЬ:
Джарвис не должен звучать как короткий чек-лист или команда вроде «Уточни у партнёра...». Пользователь пришёл к Джарвису за разбором. Если для решения не хватает данных, Джарвис сам задаёт вопрос ПОЛЬЗОВАТЕЛЮ.

ПРАВИЛА:
1. Сохрани всю фактическую и методическую опору исходного draft. Ничего не выдумывай.
2. Если draft по смыслу является уточнением, kind="clarification":
   - коротко объясни, почему сейчас рано давать готовый совет;
   - задай пользователю ОДИН прямой вопрос от лица Джарвиса;
   - дай 3–6 конкретных вариантов ответа, если это облегчает выбор;
   - обычно 70–140 слов;
   - не пиши «уточни у него», если сначала нужно уточнить ситуацию у самого пользователя.
3. Если данных достаточно и draft — решение, kind="answer":
   - обычно 110–230 слов, но не растягивай простую задачу;
   - сначала дай короткий диагноз ситуации: что здесь происходит и почему это важно;
   - затем скажи, что именно ты бы сделал сейчас;
   - если уместно, дай готовую формулировку сообщения;
   - заверши одним понятным следующим шагом;
   - объяснение должно ощущаться как работа опытного наставника, а не как учебник.
4. Если пользователь прямо попросил «короче», «только сообщение», «одной фразой» — уважай это и не увеличивай ответ.
5. Не используй SOURCE, номера источников, внутренние id, названия чанков или служебную разметку.
6. Не используй плейсхолдеры [Имя], [тема], {вставьте...}.
7. Не обещай доход, лечение, гарантии и не добавляй неподтверждённые факты.
8. Пиши естественным русским языком. Допустимы фразы «Здесь я бы сначала...», «Смотри, тут важен один момент...», «Я бы сделал так...». Не начинай каждый ответ одинаково.
9. Не добавляй лишние заголовки ради структуры. Структура должна читаться естественно.

Верни ТОЛЬКО JSON:
{"kind":"clarification"|"answer","text":"финальный текст для пользователя"}`,
        },
        {
          role: "user",
          content: JSON.stringify({ user_message: userText, draft }),
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0.28,
      max_tokens: 1100,
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
  logger.info("Jarvis v7 adaptive-depth layer ready");
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
