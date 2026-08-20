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
const DIDACTIC_STYLE_RE = /(?:^|[.!?]\s+)(?:уточни|спроси\s+(?:его|её|у\s+него|у\s+неё)|предложи\s+(?:ему|ей)|на\s+основе\s+(?:его|её)\s+ответа|это\s+поможет\s+(?:понять|прояснить)|так\s+ты\s+пойм[её]шь)/iu;
const READY_PHRASE_RE = /(?:«[^»]{12,}»|"[^"\n]{12,}"|я\s+бы\s+(?:написал|сказал)\s+так\s*:)/iu;
const USER_WANTS_SHORT_RE = /(?:короче|кратко|только\s+(?:сообщение|текст|ответ)|одной\s+фразой|без\s+объяснений)/iu;
const ZERO_ACTION_OR_OVERLOAD_RE = /(?:никому\s+(?:ещ[её]\s+)?не\s+(?:написал|написала)|ничего\s+не\s+делает|застрял|завис|перегруз|боится\s+(?:писать|отказов)|не\s+знает\s*,?\s+с\s+чего\s+начать|только\s+(?:читает|изучает))/iu;

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

function isInterpersonalWorkCase(userText: string): boolean {
  return /(?:партн[её]р|нович|кандидат|человек|знаком|клиент|переписк|сообщен|ответил|ответила|сказал|сказала|возражен|встреч|созвон)/iu.test(userText);
}

function needsMentorQualityRepair(userText: string, kind: RefineResult["kind"], text: string): boolean {
  if (SPECULATIVE_THIRD_PARTY_QUESTION_RE.test(text)) return true;
  if (!isInterpersonalWorkCase(userText)) return false;
  if (USER_WANTS_SHORT_RE.test(userText)) return false;

  if (DIDACTIC_STYLE_RE.test(text)) return true;

  if (kind === "answer") {
    const talksAboutMessaging = /(?:напис|сообщен|ответ|поговор|скажи|спроси|переписк|разговор)/iu.test(text);
    if (talksAboutMessaging && !READY_PHRASE_RE.test(text)) return true;
  }

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
          content: `Ты — финальный редактор Джарвиса, нейропомощника партнёра Greenleaf. Перед тобой уже проверенный, основанный на базе Greenleaf Coach черновик. Твоя задача — НЕ менять его методику и НЕ добавлять новые факты, а превратить его в живой, содержательный ответ сильного наставника.

КАК ДОЛЖЕН ОЩУЩАТЬСЯ ДЖАРВИС:
Не «методичка рассказывает пользователю, что ему следует уточнить», а опытный наставник рядом: быстро понимает ситуацию, объясняет суть, говорит «я бы сделал так» и даёт готовый следующий шаг.

ПРАВИЛА:
1. Сохрани всю фактическую и методическую опору исходного draft. Ничего не выдумывай.
2. Если draft по смыслу является уточнением, kind="clarification":
   - коротко объясни, какой ОДИН факт реально нужен для выбора решения;
   - задай этот вопрос прямо ПОЛЬЗОВАТЕЛЮ;
   - дай 3–6 простых вариантов ответа, если это облегчает выбор;
   - не выдавай полноценное решение до ответа;
   - не пиши «уточни у него» вместо вопроса пользователю.
3. Если данных достаточно, kind="answer":
   - коротко назови, что происходит и где здесь ключевой риск/узкое место;
   - скажи «я бы сделал так» или естественный эквивалент и дай конкретное действие;
   - если следующий шаг связан с разговором/перепиской — ОБЯЗАТЕЛЬНО дай полностью готовую естественную реплику, которую можно отправить без редактирования;
   - после реплики при необходимости дай короткую развилку по реальному ответу человека;
   - закончи действием или приглашением прислать реальный ответ для следующего разбора.
4. НЕ используй стиль «Уточни, испытывает ли он...», «Спроси его...», «На основе его ответа можно...», когда можно сразу дать пользователю готовую формулировку.
5. НЕ спрашивай пользователя, как он думает, готов/открыт/согласится ли другой человек. Это проверяется действием, а не догадкой.
6. Если человек ещё ничего не сделал, перегружен, боится или завис, первый шаг должен быть МИНИМАЛЬНЫМ и психологически безопасным. Не заставляй сразу писать нескольким людям. Выбери один маленький обратимый шаг, если именно это следует из исходной методики.
7. Не превращай ответ в длинную лекцию. Для обычного сложного разбора ориентир 120–220 слов; для простого — короче.
8. Если пользователь просит «короче», «только сообщение», «одной фразой» — выполни это буквально.
9. Не используй SOURCE, номера источников, внутренние id или служебную разметку.
10. Не используй плейсхолдеры [Имя], [тема], {вставьте...}.
11. Не обещай доход, лечение, гарантии и не добавляй неподтверждённые факты.
12. Пиши естественным русским языком, без канцелярита и без лишних заголовков.

Верни ТОЛЬКО JSON:
{"kind":"clarification"|"answer","text":"финальный текст для пользователя"}`,
        },
        {
          role: "user",
          content: JSON.stringify({
            user_message: userText,
            draft,
            interpersonal_case: isInterpersonalWorkCase(userText),
            zero_action_or_overload: ZERO_ACTION_OR_OVERLOAD_RE.test(userText),
          }),
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0.22,
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
    logger.warn({ err }, "Jarvis adaptive response refinement failed; using grounded draft");
    return null;
  }
}

async function mentorQualityRepair(
  userText: string,
  kind: RefineResult["kind"],
  text: string,
): Promise<string | null> {
  const c = getClient();
  if (!c) return null;

  try {
    const response = await c.chat.completions.create({
      model: PROXY_MODEL,
      messages: [
        {
          role: "system",
          content: `Ты — строгий quality-gate финального ответа Джарвиса. Факты и методика уже проверены RAG. Ты НЕ имеешь права добавлять новые факты или менять стратегию. Исправь только качество наставнической подачи.

ОТВЕТ ДОЛЖЕН ПРОЙТИ 5 КРИТЕРИЕВ:
1. ЖИВОЙ НАСТАВНИК: не учебник и не «инструкция пользователю составить вопрос».
2. ГОТОВАЯ РЕПЛИКА: если следующий шаг — поговорить/написать человеку, дай точный текст, который можно отправить как есть.
3. МИНИМАЛЬНЫЙ ШАГ: если человек ещё не действует, боится, завис или перегружен, не требуй сразу нескольких контактов/сообщений; оставь один небольшой безопасный шаг, если это не противоречит исходному ответу.
4. БЕЗ МЕТА-КАНЦЕЛЯРИТА: убери «уточни, испытывает ли...», «на основе ответа можно...», «это поможет прояснить состояние». Скажи по-человечески.
5. КОНКРЕТНЫЙ ФИНАЛ: действие или «пришли его реальный ответ — разберём дальше», а не гадание о чужой готовности.

Для kind="clarification" не превращай уточнение в полноценный ответ: задай пользователю один прямой вопрос с вариантами.
Для kind="answer" сохрани полезную глубину, но не делай простыню.
Если пользователь просил коротко — оставь коротко.
Не используй SOURCE, плейсхолдеры, обещания дохода/лечения/гарантий.

Верни ТОЛЬКО JSON: {"text":"финальный исправленный текст"}`,
        },
        {
          role: "user",
          content: JSON.stringify({
            user_message: userText,
            response_kind: kind,
            answer: text,
            zero_action_or_overload: ZERO_ACTION_OR_OVERLOAD_RE.test(userText),
          }),
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0.12,
      max_tokens: 1200,
    });

    const raw = response.choices[0]?.message?.content || "{}";
    const parsed = JSON.parse(raw) as { text?: string };
    const clean = parsed.text ? sanitizeJarvisUserText(parsed.text.trim()) : "";
    return clean || null;
  } catch (err) {
    logger.warn({ err }, "Jarvis mentor-quality repair failed");
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

              const interpersonal = isInterpersonalWorkCase(userText);
              const needsRepair = needsMentorQualityRepair(userText, refined.kind, finalText);

              // For interpersonal work cases, use the mentor gate proactively. This is
              // intentionally stricter than the generic style pass: quality matters more
              // than saving one model call in the 20-answer demo experience.
              if (interpersonal && !USER_WANTS_SHORT_RE.test(userText)) {
                const polished = await mentorQualityRepair(userText, refined.kind, finalText);
                if (polished) {
                  finalText = polished;
                  logger.info({ forced: !needsRepair }, "Jarvis mentor-quality gate applied");
                }
              } else if (needsRepair) {
                const repaired = await mentorQualityRepair(userText, refined.kind, finalText);
                if (repaired) finalText = repaired;
              }

              // Last deterministic safety net: a speculative question about another
              // person's internal state must never be the final output.
              if (SPECULATIVE_THIRD_PARTY_QUESTION_RE.test(finalText)) {
                const repaired = await mentorQualityRepair(userText, refined.kind, finalText);
                if (repaired && !SPECULATIVE_THIRD_PARTY_QUESTION_RE.test(repaired)) {
                  finalText = repaired;
                  logger.info("Jarvis removed speculative third-party closing question");
                }
              }

              onRefined(finalText);
              logger.info({ kind: refined.kind }, "Jarvis adapted grounded reply with mentor-quality gate");
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
  logger.info("Jarvis v7 adaptive-depth + mentor-quality gate ready");
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
