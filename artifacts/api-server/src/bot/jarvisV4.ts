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

const DORMANT_PARTNER_RE = /(?:партн[её]р|новичок).*(?:зарегистр|был\s+актив|активн).*(?:не\s+дела|редко\s+отвеч|пропал|затих|сдулся|выпал)|(?:партн[её]р|новичок).*(?:пропал|затих|редко\s+отвеч|ничего\s+не\s+дела|почти\s+ничего)/i;
const DORMANT_CAUSE_RE = /(?:отказ|не\s+получа|нет\s+результ|не\s+увидел\s+результ|не\s+понял|не\s+знает.*что\s+делать|перегруз|слишком\s+много\s+информац|нет\s+времени|занят|страх|боится|стыд|выгор|семь|работ|здоров|долг|переезд|не\s+интерес|это\s+не\s+мо[её])/i;

async function recentConversation(userId: number): Promise<Array<{ role: string; content: string }>> {
  const result = await pool.query<{ role: string; content: string }>(
    `SELECT role, content FROM (
       SELECT id, role, content
       FROM jarvis_messages
       WHERE telegram_user_id = $1 AND role IN ('user', 'assistant')
       ORDER BY id DESC
       LIMIT 14
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

function needsDormantPartnerDiagnosis(
  text: string,
  history: Array<{ role: string; content: string }>,
): boolean {
  const current = text.trim();
  if (!DORMANT_PARTNER_RE.test(current)) return false;

  // If the user already supplied a plausible reason, let the AI move to the next step.
  if (DORMANT_CAUSE_RE.test(current)) return false;

  const recentUserContext = history
    .filter((item) => item.role === "user")
    .slice(-3)
    .map((item) => item.content)
    .join("\n");

  return !DORMANT_CAUSE_RE.test(recentUserContext);
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

  if (needsDormantPartnerDiagnosis(text, history)) {
    const clarification =
      "Здесь я бы пока ничего ему не предлагал. Сначала важно понять, где именно он выпал из процесса.\n\nЧто было перед тем, как он начал отвечать реже и почти перестал действовать?\n\nНапример:\n• получил несколько отказов;\n• не понял, что делать дальше;\n• перегрузился информацией;\n• сказал, что нет времени;\n• не увидел результата;\n• просто начал пропадать без объяснений.\n\nМожно ответить одним пунктом.";

    await saveDialogueLine(userId, "user", text, "user_message");
    await saveDialogueLine(userId, "assistant", clarification, "clarification");
    await bot.sendMessage(msg.chat.id, clarification);
    return;
  }

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
