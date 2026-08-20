import type TelegramBot from "node-telegram-bot-api";
import type { Message } from "node-telegram-bot-api";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger.js";
import { handleJarvisV13Message } from "./jarvisV13.js";

const LOW = -9960001999;
const HIGH = -9960000900;
const POSITIVE_ID = -9960001100;
const NEGATIVE_ID = -9960001101;
const LOCKED_ID = -9960001102;

type Sent = { text: string; options?: any };

class FakeBot {
  sent: Sent[] = [];
  async sendMessage(chatId: any, text: string, options?: any): Promise<any> {
    this.sent.push({ text, options });
    return { message_id: this.sent.length, chat: { id: chatId }, date: Math.floor(Date.now() / 1000), text };
  }
  async sendChatAction(): Promise<boolean> { return true; }
  async answerCallbackQuery(): Promise<boolean> { return true; }
}

function msg(id: number, text: string): Message {
  return {
    message_id: Math.floor(Math.random() * 1e9),
    date: Math.floor(Date.now() / 1000),
    chat: { id, type: "private" },
    from: { id, is_bot: false, first_name: "Аудит", username: `v13_${Math.abs(id)}` },
    text,
  } as Message;
}

async function cleanup(): Promise<void> {
  await pool.query("DELETE FROM jarvis_site_cta_events WHERE telegram_user_id BETWEEN $1 AND $2", [LOW, HIGH]);
  await pool.query("DELETE FROM jarvis_messages WHERE telegram_user_id BETWEEN $1 AND $2", [LOW, HIGH]);
  await pool.query("DELETE FROM jarvis_usage WHERE telegram_user_id BETWEEN $1 AND $2", [LOW, HIGH]);
  await pool.query("DELETE FROM jarvis_profiles WHERE telegram_user_id BETWEEN $1 AND $2", [LOW, HIGH]);
}

async function counts(): Promise<{ profiles: number; usage: number; messages: number; cta: number }> {
  const [p, u, m, c] = await Promise.all([
    pool.query<{ n: string }>("SELECT COUNT(*)::text n FROM jarvis_profiles WHERE telegram_user_id BETWEEN $1 AND $2", [LOW, HIGH]),
    pool.query<{ n: string }>("SELECT COUNT(*)::text n FROM jarvis_usage WHERE telegram_user_id BETWEEN $1 AND $2", [LOW, HIGH]),
    pool.query<{ n: string }>("SELECT COUNT(*)::text n FROM jarvis_messages WHERE telegram_user_id BETWEEN $1 AND $2", [LOW, HIGH]),
    pool.query<{ n: string }>("SELECT COUNT(*)::text n FROM jarvis_site_cta_events WHERE telegram_user_id BETWEEN $1 AND $2", [LOW, HIGH]),
  ]);
  return {
    profiles: Number(p.rows[0]?.n || 0),
    usage: Number(u.rows[0]?.n || 0),
    messages: Number(m.rows[0]?.n || 0),
    cta: Number(c.rows[0]?.n || 0),
  };
}

async function named(id: number, name = "Алексей"): Promise<void> {
  await pool.query(
    `INSERT INTO jarvis_profiles(telegram_user_id,username,preferred_name,created_at,updated_at)
     VALUES($1,$2,$3,NOW(),NOW())
     ON CONFLICT(telegram_user_id) DO UPDATE SET preferred_name=EXCLUDED.preferred_name,updated_at=NOW()`,
    [id, `v13_${Math.abs(id)}`, name],
  );
  await pool.query(
    "INSERT INTO jarvis_usage(telegram_user_id,answers_used,updated_at) VALUES($1,0,NOW()) ON CONFLICT(telegram_user_id) DO NOTHING",
    [id],
  );
}

function siteButtons(sent: Sent[]): any[] {
  const buttons: any[] = [];
  for (const item of sent) {
    const rows = item.options?.reply_markup?.inline_keyboard;
    if (!Array.isArray(rows)) continue;
    for (const row of rows) for (const button of row) if (button?.url && String(button.url).includes("greenleaf-podbor")) buttons.push(button);
  }
  return buttons;
}

async function positiveAndCooldown(): Promise<boolean> {
  await named(POSITIVE_ID);
  const first = new FakeBot();
  await handleJarvisV13Message(
    first as unknown as TelegramBot,
    msg(POSITIVE_ID, "Кандидат попросил посмотреть ассортимент Greenleaf. Что ему лучше отправить, чтобы не заваливать сообщениями? Дай конкретный следующий шаг."),
  );
  const firstButtons = siteButtons(first.sent);
  const firstText = first.sent.map(x => x.text).join("\n");

  const second = new FakeBot();
  await handleJarvisV13Message(
    second as unknown as TelegramBot,
    msg(POSITIVE_ID, "Теперь другому человеку тоже интересна продукция. Что ему показать?"),
  );
  const secondButtons = siteButtons(second.sent);

  const pass = firstButtons.length === 1 && /utm_source=jarvis/iu.test(String(firstButtons[0]?.url || "")) && /сайт-каталог|персональн(?:ый|ая)\s+(?:сайт|страниц)/iu.test(firstText) && secondButtons.length === 0;
  logger.warn({ audit: "JARVIS_V13_SITE_CTA", type: "positive_cooldown", pass, first: first.sent, second: second.sent }, `V13 AUDIT POSITIVE+COOLDOWN ${pass ? "PASS" : "FAIL"}`);
  return pass;
}

async function objectionDoesNotAdvertise(): Promise<boolean> {
  await named(NEGATIVE_ID);
  const bot = new FakeBot();
  await handleJarvisV13Message(
    bot as unknown as TelegramBot,
    msg(NEGATIVE_ID, "Кандидат сказал: «Это пирамида». Что ответить спокойно?"),
  );
  const pass = siteButtons(bot.sent).length === 0;
  logger.warn({ audit: "JARVIS_V13_SITE_CTA", type: "objection_no_cta", pass, outputs: bot.sent }, `V13 AUDIT OBJECTION ${pass ? "PASS" : "FAIL"}`);
  return pass;
}

async function lockedKeepsCoachOnly(): Promise<boolean> {
  await named(LOCKED_ID, "Лимит");
  await pool.query(`ALTER TABLE jarvis_usage ADD COLUMN IF NOT EXISTS cooldown_started_at TIMESTAMPTZ`);
  await pool.query(
    `UPDATE jarvis_usage
     SET answers_used=20, window_started_at=NOW(), cooldown_started_at=NOW(), locked_until=NOW()+INTERVAL '7 days'
     WHERE telegram_user_id=$1`,
    [LOCKED_ID],
  );
  const bot = new FakeBot();
  await handleJarvisV13Message(
    bot as unknown as TelegramBot,
    msg(LOCKED_ID, "Кандидат хочет посмотреть продукцию. Что ему отправить?"),
  );
  const text = bot.sent.map(x => x.text).join("\n");
  const hasCoach = bot.sent.some(x => {
    const rows = x.options?.reply_markup?.inline_keyboard;
    return Array.isArray(rows) && rows.flat().some((button: any) => typeof button?.url === "string" && button.url.includes("greenleaf-coach"));
  });
  const pass = /^🔒/mu.test(text) && hasCoach && siteButtons(bot.sent).length === 0;
  logger.warn({ audit: "JARVIS_V13_SITE_CTA", type: "locked_coach_only", pass, outputs: bot.sent }, `V13 AUDIT LOCKED ${pass ? "PASS" : "FAIL"}`);
  return pass;
}

export async function runJarvisV13SelfAudit(): Promise<void> {
  if (process.env.JARVIS_AUDIT_ON_START !== "1") return;
  logger.warn({ audit: "JARVIS_V13_SITE_CTA", range: [LOW, HIGH] }, "V13 AUDIT START");
  await cleanup();
  try {
    const positiveCooldown = await positiveAndCooldown();
    const objectionNoCta = await objectionDoesNotAdvertise();
    const lockedCoachOnly = await lockedKeepsCoachOnly();
    const pass = positiveCooldown && objectionNoCta && lockedCoachOnly;
    logger.warn({ audit: "JARVIS_V13_SITE_CTA", type: "summary", pass, checks: { positiveCooldown, objectionNoCta, lockedCoachOnly } }, `V13 AUDIT SUMMARY ${pass ? "PASS" : "FAIL"}`);
  } finally {
    await cleanup();
    const post = await counts();
    const pass = post.profiles === 0 && post.usage === 0 && post.messages === 0 && post.cta === 0;
    logger.warn({ audit: "JARVIS_V13_SITE_CTA", type: "cleanup", post, pass }, "V13 AUDIT CLEANUP");
  }
}
