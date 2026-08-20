import type TelegramBot from "node-telegram-bot-api";
import type { Message } from "node-telegram-bot-api";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger.js";
import { handleJarvisV12Message } from "./jarvisV12.js";

const LOW = -9950001999;
const HIGH = -9950000900;
const HOLD_ID = -9950001100;
const EXHAUST_ID = -9950001101;
const RESET_ID = -9950001102;
const CONCURRENT_ID = -9950001900;

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
    from: { id, is_bot: false, first_name: "Аудит", username: `v12_${Math.abs(id)}` },
    text,
  } as Message;
}

async function ensureSchema(): Promise<void> {
  await pool.query(`ALTER TABLE jarvis_usage ADD COLUMN IF NOT EXISTS cooldown_started_at TIMESTAMPTZ`);
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
    [id, `v12_${Math.abs(id)}`, name],
  );
  await pool.query("INSERT INTO jarvis_usage(telegram_user_id,answers_used,updated_at) VALUES($1,0,NOW()) ON CONFLICT(telegram_user_id) DO NOTHING", [id]);
}

async function row(id: number): Promise<{ answers_used: number; window_started_at: Date | null; locked_until: Date | null; cooldown_started_at: Date | null }> {
  const r = await pool.query(
    `SELECT answers_used, window_started_at, locked_until, cooldown_started_at
     FROM jarvis_usage WHERE telegram_user_id=$1`,
    [id],
  );
  return r.rows[0];
}

async function send(bot: FakeBot, id: number, text: string): Promise<Sent[]> {
  await handleJarvisV12Message(bot as unknown as TelegramBot, msg(id, text));
  return bot.take();
}

function hasNoWaitCopy(text: string): boolean {
  return /не хочешь ждать/iu.test(text) && /без ограничений/iu.test(text) && /20 ответ/iu.test(text);
}

async function partialPackDoesNotExpire(): Promise<boolean> {
  await named(HOLD_ID);
  await pool.query(
    `UPDATE jarvis_usage
     SET answers_used=7, window_started_at=NOW()-INTERVAL '30 days', locked_until=NULL, cooldown_started_at=NULL
     WHERE telegram_user_id=$1`,
    [HOLD_ID],
  );
  const bot = new FakeBot();
  const out = await send(bot, HOLD_ID, "/limit");
  const state = await row(HOLD_ID);
  const text = out.map(x => x.text).join("\n");
  const pass = state.answers_used === 7 && state.window_started_at === null && state.locked_until === null && /Доступно 13 из 20/iu.test(text) && /не сгорают/iu.test(text);
  logger.warn({ audit: "JARVIS_V12_RELEASE", type: "partial_pack", pass, state, outputs: out.map(x => x.text) }, `V12 AUDIT PARTIAL ${pass ? "PASS" : "FAIL"}`);
  return pass;
}

async function exhaustionStartsSevenDays(): Promise<boolean> {
  await named(EXHAUST_ID);
  await pool.query(
    `UPDATE jarvis_usage
     SET answers_used=19, window_started_at=NOW()-INTERVAL '60 days', locked_until=NULL, cooldown_started_at=NULL
     WHERE telegram_user_id=$1`,
    [EXHAUST_ID],
  );
  const bot = new FakeBot();
  const before = Date.now();
  const out = await send(bot, EXHAUST_ID, "Кандидат сказал: «Мне дорого». Что ответить спокойно? Напиши готовый ответ.");
  const after = Date.now();
  const state = await row(EXHAUST_ID);
  const text = out.map(x => x.text).join("\n");
  const until = state.locked_until ? new Date(state.locked_until).getTime() : 0;
  const cooldown = state.cooldown_started_at ? new Date(state.cooldown_started_at).getTime() : 0;
  const seven = 7 * 24 * 60 * 60 * 1000;
  const pass = state.answers_used === 20 && cooldown >= before - 5000 && cooldown <= after + 5000 && until >= before + seven - 10000 && until <= after + seven + 10000 && hasNoWaitCopy(text);
  logger.warn({ audit: "JARVIS_V12_RELEASE", type: "exhaustion", pass, state, outputs: out.map(x => x.text) }, `V12 AUDIT EXHAUSTION ${pass ? "PASS" : "FAIL"}`);
  return pass;
}

async function cooldownResetsToFreshPack(): Promise<boolean> {
  await named(RESET_ID);
  await pool.query(
    `UPDATE jarvis_usage
     SET answers_used=20,
         window_started_at=NOW()-INTERVAL '8 days',
         cooldown_started_at=NOW()-INTERVAL '8 days',
         locked_until=NOW()-INTERVAL '1 day'
     WHERE telegram_user_id=$1`,
    [RESET_ID],
  );
  const bot = new FakeBot();
  const out = await send(bot, RESET_ID, "/limit");
  const state = await row(RESET_ID);
  const text = out.map(x => x.text).join("\n");
  const pass = state.answers_used === 0 && state.window_started_at === null && state.cooldown_started_at === null && state.locked_until === null && /Доступно 20 из 20/iu.test(text);
  logger.warn({ audit: "JARVIS_V12_RELEASE", type: "reset", pass, state, outputs: out.map(x => x.text) }, `V12 AUDIT RESET ${pass ? "PASS" : "FAIL"}`);
  return pass;
}

async function concurrencyStillSafe(): Promise<boolean> {
  await named(CONCURRENT_ID, "Квота");
  await pool.query(
    `UPDATE jarvis_usage
     SET answers_used=19, window_started_at=NULL, locked_until=NULL, cooldown_started_at=NULL
     WHERE telegram_user_id=$1`,
    [CONCURRENT_ID],
  );
  const prompt = "Кандидат сказал: «Мне дорого». Что ответить спокойно? Напиши готовый ответ.";
  const b1 = new FakeBot();
  const b2 = new FakeBot();
  await Promise.all([
    handleJarvisV12Message(b1 as unknown as TelegramBot, msg(CONCURRENT_ID, prompt)),
    handleJarvisV12Message(b2 as unknown as TelegramBot, msg(CONCURRENT_ID, prompt)),
  ]);
  const all = [...b1.sent, ...b2.sent];
  const state = await row(CONCURRENT_ID);
  const substantive = all.filter(x => !/^🔒|^Осталось|^Остался/iu.test(x.text));
  const pass = state.answers_used === 20 && !!state.cooldown_started_at && !!state.locked_until && substantive.length === 1 && all.some(x => hasNoWaitCopy(x.text));
  logger.warn({ audit: "JARVIS_V12_RELEASE", type: "concurrency", pass, state, outputs: all.map(x => x.text) }, `V12 AUDIT CONCURRENCY ${pass ? "PASS" : "FAIL"}`);
  return pass;
}

export async function runJarvisV12SelfAudit(): Promise<void> {
  if (process.env.JARVIS_AUDIT_ON_START !== "1") return;
  await ensureSchema();
  logger.warn({ audit: "JARVIS_V12_RELEASE", range: [LOW, HIGH] }, "V12 AUDIT START");
  await cleanup();
  try {
    const partial = await partialPackDoesNotExpire();
    const exhaustion = await exhaustionStartsSevenDays();
    const reset = await cooldownResetsToFreshPack();
    const concurrency = await concurrencyStillSafe();
    const pass = partial && exhaustion && reset && concurrency;
    logger.warn({ audit: "JARVIS_V12_RELEASE", type: "summary", pass, checks: { partial, exhaustion, reset, concurrency } }, `V12 AUDIT SUMMARY ${pass ? "PASS" : "FAIL"}`);
  } finally {
    await cleanup();
    const post = await counts();
    const pass = post.profiles === 0 && post.usage === 0 && post.messages === 0;
    logger.warn({ audit: "JARVIS_V12_RELEASE", type: "cleanup", post, pass }, "V12 AUDIT CLEANUP");
  }
}
