import TelegramBot from "node-telegram-bot-api";
import type { CallbackQuery, Message } from "node-telegram-bot-api";
import { pool } from "@workspace/db";
import {
  handleJarvisMessage as handleJarvisV3Message,
  handleJarvisCallback,
  initJarvis,
} from "./jarvisV3.js";

const UNKNOWN_RELATION_RE = /(?:вообще|совсем|лично)\s+(?:не\s+знаком|незнаком)|мы\s+(?:вообще\s+)?(?:не\s+знаком|незнаком)/i;
const COLD_CONTEXT_RE = /холодн\w*\s+(?:наблюдател|контакт|кандидат)|перв(?:ое|ый)\s+(?:сообщение|касание)|хочу\s+написать/i;

async function recentConversation(userId: number): Promise<Array<{ role: string; content: string }>> {
  const result = await pool.query<{ role: string; content: string }>(
    `SELECT role, content FROM (
       SELECT id, role, content
       FROM jarvis_messages
       WHERE telegram_user_id = $1 AND role IN ('user', 'assistant')
       ORDER BY id DESC
       LIMIT 12
     ) x ORDER BY id ASC`,
    [userId],
  );
  return result.rows;
}

function needsRealHookClarification(
  text: string,
  history: Array<{ role: string; content: string }>,
): boolean {
  if (!UNKNOWN_RELATION_RE.test(text)) return false;

  const previous = history.map((item) => item.content).join("\n");
  return COLD_CONTEXT_RE.test(previous) || /как\s+этот\s+человек\s+уже\s+соприкаса/i.test(previous);
}

async function saveDialogueLine(
  userId: number,
  role: "user" | "assistant",
  content: string,
  messageType: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO jarvis_messages (telegram_user_id, role, content, message_type, counted)
     VALUES ($1, $2, $3, $4, FALSE)`,
    [userId, role, content, messageType],
  );
}

export { initJarvis, handleJarvisCallback };

export async function handleJarvisMessage(bot: TelegramBot, msg: Message): Promise<void> {
  const userId = msg.from?.id;
  const text = msg.text?.trim() || "";

  if (!userId || !text || text.startsWith("/")) {
    await handleJarvisV3Message(bot, msg);
    return;
  }

  await initJarvis();
  const history = await recentConversation(userId);

  if (!needsRealHookClarification(text, history)) {
    await handleJarvisV3Message(bot, msg);
    return;
  }

  const clarification =
    "Понял. Тогда не будем придумывать человеку интересы и писать наугад. Для холодного контакта нужен реальный повод, почему ты выбрал именно его.\n\nОткуда этот человек у тебя появился?\n\nНапример:\n• просто подписался на тебя;\n• увидел его комментарий под конкретной темой;\n• вы в одной тематической группе;\n• попался его профиль и там есть понятный интерес/деятельность;\n• его кто-то порекомендовал;\n• другой реальный повод.\n\nОтветь одним пунктом — и я соберу сообщение уже под этот контекст.";

  await saveDialogueLine(userId, "user", text, "user_message");
  await saveDialogueLine(userId, "assistant", clarification, "clarification");
  await bot.sendMessage(msg.chat.id, clarification);
}

export async function handleJarvisCallbackV4(bot: TelegramBot, query: CallbackQuery): Promise<void> {
  await handleJarvisCallback(bot, query);
}
