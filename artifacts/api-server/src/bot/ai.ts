import OpenAI from "openai";
import { db } from "@workspace/db";
import { aiLogsTable, messagesTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import { SYSTEM_PROMPT } from "./prompts.js";

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

export interface KnownFacts {
  displayName?: string | null;
  brandName?: string | null;
  intent?: string | null;
  familyAdults?: number | null;
  partnerId?: number | null;
  currentStage?: string;
}

export async function buildMessageHistory(sessionId: number, limit: number = 8): Promise<{ role: "user" | "assistant"; content: string }[]> {
  const rows = await db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.sessionId, sessionId))
    .orderBy(desc(messagesTable.createdAt))
    .limit(limit);

  return rows
    .reverse()
    .map((r) => ({
      role: (r.role === "bot" ? "assistant" : "user") as "user" | "assistant",
      content: r.content,
    }));
}

export async function generateStageReply(
  userText: string | null,
  stage: string,
  stagePrompt: string,
  knownFacts: KnownFacts,
  sessionId?: number
): Promise<string | null> {
  const c = getClient();
  if (!c) return null;

  const history = sessionId ? await buildMessageHistory(sessionId) : [];

  const factsText = [
    knownFacts.displayName ? `Имя пользователя: ${knownFacts.displayName}` : "",
    knownFacts.brandName ? `Бренд: ${knownFacts.brandName}` : "",
    knownFacts.intent ? `Намеренный intent: ${knownFacts.intent}` : "",
    knownFacts.familyAdults ? `Членов семьи: ${knownFacts.familyAdults}` : "",
    knownFacts.currentStage ? `Текущий этап: ${knownFacts.currentStage}` : "",
  ].filter(Boolean).join("\n");

  const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
    { role: "system", content: SYSTEM_PROMPT },
  ];

  if (factsText) {
    messages.push({ role: "system", content: `\u0418звестные данные:\n${factsText}` });
  }

  if (stagePrompt) {
    messages.push({ role: "system", content: stagePrompt });
  }

  for (const h of history) {
    messages.push({ role: h.role, content: h.content });
  }

  if (userText) {
    messages.push({ role: "user", content: userText });
  }

  try {
    const resp = await c.chat.completions.create({
      model: PROXY_MODEL,
      messages,
      max_tokens: 600,
      temperature: 0.7,
    });
    const output = resp.choices[0]?.message?.content?.trim() || null;
    if (sessionId && output) {
      await db.insert(aiLogsTable).values({
        sessionId,
        promptType: "stage_reply",
        input: userText ?? "(init)",
        output,
        success: true,
      });
    }
    return output;
  } catch (err) {
    logger.error({ err }, "AI stage reply error");
    if (sessionId) {
      await db.insert(aiLogsTable).values({
        sessionId,
        promptType: "stage_reply",
        input: userText ?? "(init)",
        output: null,
        success: false,
        error: String(err),
      });
    }
    return null;
  }
}

// Legacy functions kept for compatibility and fallback
export async function classifyUserInput(
  text: string,
  stage: string,
  sessionId?: number
): Promise<{ intent: string; brandName?: string }> {
  const c = getClient();
  if (!c) return { intent: "other" };

  const prompt = `\u0422\u044b \u043a\u043b\u0430\u0441\u0441\u0438\u0444\u0438\u043a\u0430\u0442\u043e\u0440 \u043e\u0442\u0432\u0435\u0442\u043e\u0432 \u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u044f Telegram-\u0431\u043e\u0442\u0430 \u043e \u0442\u043e\u0432\u0430\u0440\u0430\u0445 \u0434\u043b\u044f \u0434\u043e\u043c\u0430 Greenleaf.
\u042d\u0442\u0430\u043f \u0441\u0446\u0435\u043d\u0430\u0440\u0438\u044f: ${stage}
\u041e\u0442\u0432\u0435\u0442 \u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u044f: "${text}"

\u041e\u043f\u0440\u0435\u0434\u0435\u043b\u0438 intent \u0438\u0437 \u0441\u043f\u0438\u0441\u043a\u0430:
- mass_market_brand (Ariel, Tide, Persil, Fairy, AOS, Zewa, Losk, \u041b\u0430\u0441\u043a\u0430 \u0438 \u043f\u043e\u0434\u043e\u0431\u043d\u044b\u0435)
- eco_brand (Synergetic, BioMio, Amway \u0438 \u043f\u043e\u0434\u043e\u0431\u043d\u044b\u0435)
- unknown (\u043d\u0435 \u0437\u043d\u0430\u044e, \u043d\u0435 \u043f\u043e\u043c\u043d\u044e, \u043d\u0435 \u0437\u043d\u0430\u043a\u043e\u043c)
- not_used (\u043d\u0435 \u043f\u043e\u043b\u044c\u0437\u0443\u044e\u0441\u044c)
- objection_price (\u0434\u043e\u0440\u043e\u0433\u043e)
- objection_pyramid (\u044d\u0442\u043e \u043f\u0438\u0440\u0430\u043c\u0438\u0434\u0430?)
- wants_calculation (\u0445\u043e\u0447\u0443 \u0440\u0430\u0441\u0447\u0451\u0442)
- wants_registration (\u0445\u043e\u0447\u0443 \u0437\u0430\u0440\u0435\u0433\u0438\u0441\u0442\u0440\u0438\u0440\u043e\u0432\u0430\u0442\u044c\u0441\u044f/\u043f\u043e\u0434\u043a\u043b\u044e\u0447\u0438\u0442\u044c\u0441\u044f)
- price_question (\u0441\u043a\u043e\u043b\u044c\u043a\u043e \u0441\u0442\u043e\u0438\u0442?)
- soft_decline (\u043d\u0435 \u0438\u043d\u0442\u0435\u0440\u0435\u0441\u043d\u043e)
- affirmative (\u0434\u0430, \u043e\u043a, \u0434\u0430\u0432\u0430\u0439)
- negative (\u043d\u0435\u0442)
- question (\u0432\u043e\u043f\u0440\u043e\u0441)
- other

\u041e\u0442\u0432\u0435\u0442\u044c \u0442\u043e\u043b\u044c\u043a\u043e JSON: {"intent": "...", "brandName": "..." \u0438\u043b\u0438 null}`;

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

  const prompt = `\u0422\u044b \u0431\u043e\u0442 Greenleaf. \u0414\u0430\u0439 \u043a\u043e\u0440\u043e\u0442\u043a\u0443\u044e \u0436\u0438\u0432\u0443\u044e \u0440\u0435\u0430\u043a\u0446\u0438\u044e (2-3 \u043f\u0440\u0435\u0434\u043b\u043e\u0436\u0435\u043d\u0438\u044f) \u043d\u0430 \u043e\u0442\u0432\u0435\u0442 \u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u044f.
\u041f\u0440\u0430\u0432\u0438\u043b\u0430 \u0442\u043e\u043d\u0430: \u0441\u043f\u043e\u043a\u043e\u0439\u043d\u043e, \u043f\u043e-\u0447\u0435\u043b\u043e\u0432\u0435\u0447\u0435\u0441\u043a\u0438, \u0431\u0435\u0437 \u0434\u0430\u0432\u043b\u0435\u043d\u0438\u044f. \u041d\u0435\u043b\u044c\u0437\u044f \u043f\u0438\u0441\u0430\u0442\u044c \u0447\u0442\u043e \u043f\u0440\u043e\u0434\u0443\u043a\u0442\u044b \u043b\u0435\u0447\u0430\u0442 \u0431\u043e\u043b\u0435\u0437\u043d\u0438 \u0438\u043b\u0438 \u0433\u0430\u0440\u0430\u043d\u0442\u0438\u0440\u0443\u044e\u0442 \u0434\u043e\u0445\u043e\u0434.
\u042d\u0442\u0430\u043f: ${stage}, intent: ${intent}, \u0431\u0440\u0435\u043d\u0434: ${brandName || "\u043d\u0435 \u0443\u043a\u0430\u0437\u0430\u043d"}
\u041e\u0442\u0432\u0435\u0442 \u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u044f: "${userText}"
\u041d\u0430\u043f\u0438\u0448\u0438 \u0442\u043e\u043b\u044c\u043a\u043e \u0442\u0435\u043a\u0441\u0442 \u0440\u0435\u0430\u043a\u0446\u0438\u0438, \u0431\u0435\u0437 \u043a\u0430\u0432\u044b\u0447\u0435\u043a.`;

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

  const prompt = `\u0422\u044b \u0431\u043e\u0442 Greenleaf. \u041e\u0442\u0432\u0435\u0447\u0430\u0439 \u043a\u043e\u0440\u043e\u0442\u043a\u043e (1-3 \u043f\u0440\u0435\u0434\u043b\u043e\u0436\u0435\u043d\u0438\u044f) \u043d\u0430 \u0432\u043e\u043f\u0440\u043e\u0441 \u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u044f.
\u041d\u0435\u043b\u044c\u0437\u044f \u043e\u0431\u0435\u0449\u0430\u0442\u044c \u043b\u0435\u0447\u0435\u043d\u0438\u0435, \u0433\u0430\u0440\u0430\u043d\u0442\u0438\u0440\u043e\u0432\u0430\u043d\u043d\u044b\u0439 \u0434\u043e\u0445\u043e\u0434, \u0433\u0430\u0440\u0430\u043d\u0442\u0438\u0440\u043e\u0432\u0430\u043d\u043d\u044b\u0439 \u0432\u043e\u0437\u0432\u0440\u0430\u0442 \u0434\u0435\u043d\u0435\u0433.
\u042d\u0442\u0430\u043f \u0441\u0446\u0435\u043d\u0430\u0440\u0438\u044f: ${stage}
\u0412\u043e\u043f\u0440\u043e\u0441: "${question}"
\u041f\u043e\u0441\u043b\u0435 \u043e\u0442\u0432\u0435\u0442\u0430 \u0434\u043e\u0431\u0430\u0432\u044c: "\u041f\u0440\u043e\u0434\u043e\u043b\u0436\u0438\u043c \u0440\u0430\u0437\u0431\u043e\u0440?"`;

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
