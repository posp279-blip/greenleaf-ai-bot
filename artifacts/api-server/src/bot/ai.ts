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
- mass_market_brand (Ariel, Tide, Persil, Fairy, AOS, Zewa, Losk, Ласка и подобные)
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

  const prompt = `Ты бот Greenleaf. Дай короткую живую реакцию (2-3 предложения) на ответ пользователя.
Правила тона: спокойно, по-человечески, без давления. Нельзя писать что продукты лечат болезни или гарантируют доход.
Этап: ${stage}, intent: ${intent}, бренд: ${brandName || "не указан"}
Ответ пользователя: "${userText}"
Напиши только текст реакции, без кавычек.`;

  try {
    const resp = await c.chat.completions.create({
      model: PROXY_MODEL,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 150,
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

  const prompt = `Ты бот Greenleaf. Отвечай коротко (1-3 предложения) на вопрос пользователя.
Нельзя обещать лечение, гарантированный доход, гарантированный возврат денег.
Этап сценария: ${stage}
Вопрос: "${question}"
После ответа добавь: "Продолжим разбор?"`;

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
