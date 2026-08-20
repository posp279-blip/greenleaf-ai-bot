import type TelegramBot from "node-telegram-bot-api";
import type { Message } from "node-telegram-bot-api";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger.js";
import { handleJarvisV11Message } from "./jarvisV11.js";

const LOW = -9940001999;
const HIGH = -9940000900;
const COLD_ID = -9940001100;
const MEMORY_ID = -9940001101;
const QUOTA_ID = -9940001900;

type Sent = { text: string; options?: any };

class FakeBot {
  sent: Sent[] = [];
  async sendMessage(chatId: any, text: string, options?: any): Promise<any> {
    this.sent.push({ text, options });
    return { message_id: this.sent.length, chat: { id: chatId }, date: Math.floor(Date.now() / 1000), text };
  }
  async sendChatAction(): Promise<boolean> { return true; }
  async answerCallbackQuery(): Promise<boolean> { return true; }
  take(): Sent[] { const out = [...this.sent]; this.sent = []; return out; }
}

function msg(id: number, text: string): Message {
  return {
    message_id: Math.floor(Math.random() * 1e9),
    date: Math.floor(Date.now() / 1000),
    chat: { id, type: "private" },
    from: { id, is_bot: false, first_name: "Аудит", username: `v11final_${Math.abs(id)}` },
    text,
  } as Message;
}

async function cleanup(): Promise<void> {
  await pool.query("DELETE FROM jarvis_messages WHERE telegram_user_id BETWEEN $1 AND $2", [LOW, HIGH]);
  await pool.query("DELETE FROM jarvis_usage WHERE telegram_user_id BETWEEN $1 AND $2", [LOW, HIGH]);
  await pool.query("DELETE FROM jarvis_profiles WHERE telegram_user_id BETWEEN $1 AND $2", [LOW, HIGH]);
}

async function counts(): Promise<{ profiles: number; usage: number; messages: number }> {
  const [p, u, m] = await Promise.all([
    pool.query<{ n: string }>("SELECT COUNT(*)::text n FROM jarvis_profiles WHERE telegram_user_id BETWEEN $1 AND $2", [LOW, HIGH]),
    pool.query<{ n: string }>("SELECT COUNT(*)::text n FROM jarvis_usage WHERE telegram_user_id BETWEEN $1 AND $2", [LOW, HIGH]),
    pool.query<{ n: string }>("SELECT COUNT(*)::text n FROM jarvis_messages WHERE telegram_user_id BETWEEN $1 AND $2", [LOW, HIGH]),
  ]);
  return { profiles: Number(p.rows[0]?.n || 0), usage: Number(u.rows[0]?.n || 0), messages: Number(m.rows[0]?.n || 0) };
}

async function named(id: number, name = "Алексей"): Promise<void> {
  await pool.query(
    `INSERT INTO jarvis_profiles(telegram_user_id,username,preferred_name,created_at,updated_at)
     VALUES($1,$2,$3,NOW(),NOW())
     ON CONFLICT(telegram_user_id) DO UPDATE SET preferred_name=EXCLUDED.preferred_name,updated_at=NOW()`,
    [id, `v11final_${Math.abs(id)}`, name],
  );
  await pool.query("INSERT INTO jarvis_usage(telegram_user_id,answers_used,updated_at) VALUES($1,0,NOW()) ON CONFLICT(telegram_user_id) DO NOTHING", [id]);
}

async function usage(id: number): Promise<number> {
  const r = await pool.query<{ answers_used: number }>("SELECT answers_used FROM jarvis_usage WHERE telegram_user_id=$1", [id]);
  return Number(r.rows[0]?.answers_used || 0);
}

async function counted(id: number): Promise<number> {
  const r = await pool.query<{ n: string }>("SELECT COUNT(*)::text n FROM jarvis_messages WHERE telegram_user_id=$1 AND role='assistant' AND counted=TRUE", [id]);
  return Number(r.rows[0]?.n || 0);
}

async function send(bot: FakeBot, id: number, text: string): Promise<Sent[]> {
  await handleJarvisV11Message(bot as unknown as TelegramBot, msg(id, text));
  return bot.take();
}

function ready(text: string): boolean {
  return /«[^»]{18,}»|"[^"\n]{18,}"/u.test(text);
}

async function coldCheck(): Promise<boolean> {
  await named(COLD_ID);
  const bot = new FakeBot();
  const start = await usage(COLD_ID);
  await send(bot, COLD_ID, "Хочу написать первое сообщение холодному наблюдателю");
  const afterAsk = await usage(COLD_ID);
  const out = await send(bot, COLD_ID, "вообще лично не знакомы, увидел его комментарий в тематической группе");
  const text = out.map(x => x.text).join("\n");
  const pass = start === afterAsk && (await usage(COLD_ID)) === start + 1 && ready(text);
  logger.warn({ audit: "JARVIS_V11_FINAL", type: "cold", pass, outputs: out.map(x => x.text) }, `V11 FINAL COLD ${pass ? "PASS" : "FAIL"}`);
  return pass;
}

async function memoryCheck(): Promise<boolean> {
  await named(MEMORY_ID);
  const bot = new FakeBot();
  await send(bot, MEMORY_ID, "Кандидата зовут Оля, она бывшая коллега. Её смущает сумма старта.");
  await send(bot, MEMORY_ID, "Мы ещё поговорили о продукте.");
  const out = await send(bot, MEMORY_ID, "Она ответила: «Я пока не готова платить такую сумму». Что написать?");
  const text = out.map(x => x.text).join("\n");
  const pass = /Оля/iu.test(text) && ready(text) && !/\[[^\]]+\]/u.test(text);
  logger.warn({ audit: "JARVIS_V11_FINAL", type: "memory", pass, outputs: out.map(x => x.text) }, `V11 FINAL MEMORY ${pass ? "PASS" : "FAIL"}`);
  return pass;
}

async function concurrencyCheck(): Promise<boolean> {
  await named(QUOTA_ID, "Квота");
  await pool.query("UPDATE jarvis_usage SET answers_used=19,window_started_at=NOW(),locked_until=NULL,updated_at=NOW() WHERE telegram_user_id=$1", [QUOTA_ID]);
  const before = await counted(QUOTA_ID);
  const prompt = "Кандидат сказал: «Мне дорого». Что ответить спокойно? Напиши готовый ответ.";
  const b1 = new FakeBot();
  const b2 = new FakeBot();
  await Promise.all([
    handleJarvisV11Message(b1 as unknown as TelegramBot, msg(QUOTA_ID, prompt)),
    handleJarvisV11Message(b2 as unknown as TelegramBot, msg(QUOTA_ID, prompt)),
  ]);
  const all = [...b1.sent, ...b2.sent];
  const substantive = all.filter(x => !/лимит.*закончился|Осталось|Остался/iu.test(x.text));
  const pass = (await usage(QUOTA_ID)) === 20 && (await counted(QUOTA_ID)) - before === 1 && substantive.length === 1;
  logger.warn({ audit: "JARVIS_V11_FINAL", type: "concurrency", pass, outputs: all.map(x => x.text), usage: await usage(QUOTA_ID) }, `V11 FINAL CONCURRENCY ${pass ? "PASS" : "FAIL"}`);
  return pass;
}

export async function runJarvisV11FinalAudit(): Promise<void> {
  if (process.env.JARVIS_AUDIT_ON_START !== "1") return;
  logger.warn({ audit: "JARVIS_V11_FINAL", range: [LOW, HIGH] }, "V11 FINAL AUDIT START");
  await cleanup();
  try {
    const cold = await coldCheck();
    const memory = await memoryCheck();
    const concurrency = await concurrencyCheck();
    const pass = cold && memory && concurrency;
    logger.warn({ audit: "JARVIS_V11_FINAL", type: "summary", pass, checks: { cold, memory, concurrency } }, `V11 FINAL AUDIT SUMMARY ${pass ? "PASS" : "FAIL"}`);
  } finally {
    await cleanup();
    const post = await counts();
    const pass = post.profiles === 0 && post.usage === 0 && post.messages === 0;
    logger.warn({ audit: "JARVIS_V11_FINAL", type: "cleanup", post, pass }, "V11 FINAL AUDIT CLEANUP");
  }
}
