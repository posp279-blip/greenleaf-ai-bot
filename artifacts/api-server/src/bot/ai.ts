import OpenAI from "openai";
import { db } from "@workspace/db";
import { aiLogsTable } from "@workspace/db";
import { logger } from "../lib/logger.js";

const PROXY_BASE_URL =
  process.env.PROXY_API_BASE_URL || "https://api.proxyapi.ru/openai/v1";
const PROXY_MODEL = process.env.PROXY_API_MODEL || "gpt-4o-mini";
const AI_ENABLED = process.env.AI_ENABLED !== "false";

let client: OpenAI | null = null;

function getClient(): OpenAI | null {
  if (!AI_ENABLED) return null;
  const key = process.env.PROXY_API_KEY || process.env.PROXY_API_TOKEN;
  if (!key) return null;
  if (!client) {
    client = new OpenAI({ apiKey: key, baseURL: PROXY_BASE_URL });
  }
  return client;
}

export async function isAiAvailable(): Promise<boolean> {
  const c = getClient();
  if (!c) return false;
  try {
    await c.chat.completions.create({
      model: PROXY_MODEL,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 5,
    });
    return true;
  } catch {
    return false;
  }
}

export async function classifyUserInput(
  text: string,
  stage: string,
  sessionId?: number
): Promise<{ intent: string; brandName?: string }> {
  const c = getClient();
  if (!c) return { intent: "other" };

  const prompt = `Ты классификатор ответов пользователя Telegram-бота о товарах для дома Greenleaf.
Этап сценария: ${stage}
Ответ пользователя: "${text}"

Определи intent из списка:
- mass_market_brand (Ariel, Tide, Persil, Fairy, AOS, Zewa, Losk, Ласка, Миф, БиМакс, Дося и подобные)
- eco_brand (Synergetic, BioMio, Amway и подобные)
- unknown (не знаю, не помню, не знаком)
- not_used (не пользуюсь)
- objection_price (дорого)
- objection_pyramid (это пирамида?)
- wants_calculation (хочу расчёт)
- wants_registration (хочу зарегистрироваться/подключиться)
- price_question (сколько стоит?)
- soft_decline (не интересно)
- affirmative (да, ок, давай)
- negative (нет)
- question (вопрос)
- other

Ответь только JSON: {"intent": "...", "brandName": "..." или null}`;

  try {
    const resp = await c.chat.completions.create({
      model: PROXY_MODEL,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 50,
      response_format: { type: "json_object" },
    });
    const raw = resp.choices[0]?.message?.content || "{}";
    const parsed = JSON.parse(raw);
    if (sessionId) {
      await db.insert(aiLogsTable).values({
        sessionId,
        promptType: "classify",
        input: text,
        output: raw,
        success: true,
      });
    }
    return { intent: parsed.intent || "other", brandName: parsed.brandName };
  } catch (err) {
    logger.error({ err }, "AI classify error");
    if (sessionId) {
      await db.insert(aiLogsTable).values({
        sessionId,
        promptType: "classify",
        input: text,
        output: null,
        success: false,
        error: String(err),
      });
    }
    return { intent: "other" };
  }
}

export async function generateReaction(
  userText: string,
  intent: string,
  stage: string,
  brandName?: string,
  sessionId?: number
): Promise<string | null> {
  const c = getClient();
  if (!c) return null;

  const prompt = `Ты — бот Greenleaf. Дай живую, дружескую реакцию на ответ пользователя. 2-4 коротких сообщения, как будто спокойно объясняешь знакомому.

Правила тона:
- Тёплый, простой, разговорный.
- Можно начинать со слов: "Слушай", "Смотри", "Нормально, многие так делают", "Давай по-человечески".
- Никаких лекций, страшилок, давления, экспертного тона.
- Не пиши: "согласно составу", "необходимо обратить внимание", "данный компонент", "следует учитывать", "потребитель должен понимать", "рекомендуется", "экспертный анализ показывает".
- Не обещай лечение болезней, не говори что продукты гарантированно вредны или полезны.
- Не обещай гарантированный доход, гарантированный возврат денег, бесплатную продукцию.
- Допустимо: "может вызывать вопросы", "может быть нежелательно при чувствительности", "стоит обращать внимание", "это не медицинская консультация", "расчёт примерный", "результат зависит от действий".

СТРОГИЕ ЗАПРЕТЫ (если intent = mass_market_brand или это стирка или посуда):
- НЕЛЬЗЯ хвалить масс-маркет бренд. Не пиши: "отличный выбор", "популярный вариант", "многие предпочитают", "неплохие отзывы", "хорошо справляется", "проверяй что подходит тебе", "каждому своё", "эффективное средство".
- НЕЛЬЗЯ заканчивать тупиком. Не пиши: "если будут вопросы спрашивай", "надеюсь помог", "обращайся", "удачи", "каждому своё", "выбирай что нравится", "как пожелаешь".
- КАЖДЫЙ ответ ДОЛЖЕН заканчиваться понятным вопросом или предложением продолжить: "Хочешь, я коротко покажу...?", "Давай посмотрим...?", "Интересно узнать...?"
- Позиция: это привычный автоматический выбор, который стоит пересмотреть с точки зрения состава, выполаскивания, расхода и годовых трат.
- Обязательно: после стирки одежда каждый день касается кожи. Важно смотреть не только на запах и цену пачки, а на состав, выполаскивание и расход.

Этап: ${stage}, intent: ${intent}, бренд: ${brandName || "не указан"}
Ответ пользователя: "${userText}"

Напиши только текст реакции, без кавычек, без приветствий вроде "Привет!". Обязательно закончи вопросом или предложением продолжить разбор.`;

  try {
    const resp = await c.chat.completions.create({
      model: PROXY_MODEL,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 200,
    });
    const output = resp.choices[0]?.message?.content?.trim() || null;
    if (sessionId && output) {
      await db.insert(aiLogsTable).values({
        sessionId,
        promptType: "reaction",
        input: userText,
        output,
        success: true,
      });
    }
    return output;
  } catch (err) {
    logger.error({ err }, "AI reaction error");
    return null;
  }
}

export async function answerQuestion(
  question: string,
  stage: string,
  sessionId?: number
): Promise<string | null> {
  const c = getClient();
  if (!c) return null;

  const prompt = `Ты — бот Greenleaf. Отвечай на вопрос пользователя коротко, по-человечески, без лекций.

Правила тона:
- Тёплый, простой, разговорный.
- Без давления и страшилок.
- Не обещай лечение, гарантированный доход, гарантированный возврат денег, бесплатную продукцию.
- Допустимо: "это не медицинская консультация", "расчёт примерный", "результат зависит от действий".

Этап сценария: ${stage}
Вопрос: "${question}"

Ответь в 1-3 предложения. Обязательно закончи вопросом относительно текущего этапа сценария, чтобы пользователь понял, что писать дальше. Не заканчивай тупиковыми фразами вроде "спрашивай", "обращайся", "удачи".`;

  try {
    const resp = await c.chat.completions.create({
      model: PROXY_MODEL,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 200,
    });
    const output = resp.choices[0]?.message?.content?.trim() || null;
    if (sessionId && output) {
      await db.insert(aiLogsTable).values({
        sessionId,
        promptType: "answer_question",
        input: question,
        output,
        success: true,
      });
    }
    return output;
  } catch (err) {
    logger.error({ err }, "AI answer error");
    return null;
  }
}
