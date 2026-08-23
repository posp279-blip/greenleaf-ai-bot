import TelegramBot from "node-telegram-bot-api";
import type { CallbackQuery, Message } from "node-telegram-bot-api";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger.js";
import {
  handleJarvisV17Message,
  handleJarvisV17Callback,
  initJarvisV17,
} from "./jarvisV17.js";

const LIMIT = 20;
const COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const APP_URL = process.env.JARVIS_APP_URL || "https://greenleaf-coach.replit.app";
const TIME_ZONE = process.env.JARVIS_TIME_ZONE || "Europe/Moscow";

const TIMEOUT_COPY_RE = /^Не получил ответ от AI за разумное время\./u;
const INVITE_PRESENTATION_RE = /(?:приглас|позвать|приглаш).{0,90}(?:встреч|презентац|созвон)|(?:встреч|презентац).{0,90}(?:приглас|позвать)/iu;
const MEETING_PREP_RE = /(?:подготов|готов).{0,80}(?:встреч|презентац|созвон)|(?:встреч|презентац).{0,80}(?:подготов|готов)/iu;
const PYRAMID_RE = /пирамид/iu;
const PRICE_RE = /(?:дорог|цена|сумм|стоим|вход)/iu;
const THINK_RE = /(?:надо|нужно|хочу)\s+подумать|подумаю/iu;
const NO_TIME_RE = /нет\s+времени|времени\s+нет/iu;
const SLEEPING_PARTNER_RE = /(?:спящ|пропал|перестал.{0,40}(?:делать|работать)|не\s+выходит\s+на\s+связь|сдулся).{0,100}партн|партн.{0,100}(?:спящ|пропал|перестал|сдулся)/iu;
const NEWCOMER_STUCK_RE = /(?:нович|новый\s+партн).{0,120}(?:ничего\s+не\s+делает|не\s+пишет|боится|завис|только\s+читает|не\s+начинает)/iu;
const FIRST_CONTACT_RE = /(?:первое\s+сообщение|как\s+начать|как\s+написать).{0,120}(?:знаком|кандидат|наблюдател|человек)|(?:знаком|кандидат|наблюдател).{0,120}(?:первое\s+сообщение|как\s+начать|как\s+написать)/iu;

type FallbackResult = {
  responseType: "answer" | "clarification";
  text: string;
};

type QuotaRow = {
  answers_used: number;
  locked_until: Date | null;
  cooldown_started_at: Date | null;
};

type Reserved = {
  allowed: boolean;
  remaining: number;
  lockedUntil: Date | null;
};

type SendMessageArgs = Parameters<TelegramBot["sendMessage"]>;

function deterministicFallback(userText: string): FallbackResult | null {
  if (INVITE_PRESENTATION_RE.test(userText)) {
    return {
      responseType: "answer",
      text: `В приглашении не нужно проводить саму презентацию. Цель первого сообщения — спокойно договориться о короткой встрече.\n\nЯ бы написал так:\n\n«Привет! Есть одна тема, которую гораздо проще показать на встрече, чем объяснять в переписке. Думаю, тебе может быть интересно посмотреть. Давай на 20–30 минут пересечёмся — тебе удобнее сегодня вечером или завтра?»\n\nНа самой встрече сначала пойми, что человеку интересно, затем покажи 2–3 уместных примера и договорись о конкретном следующем шаге.`,
    };
  }

  if (MEETING_PREP_RE.test(userText)) {
    return {
      responseType: "answer",
      text: `Перед встречей не готовь длинную лекцию. Твоя задача — понять интерес человека и провести разговор по понятной структуре.\n\nЯ бы подготовил четыре вещи:\n1. 2–3 вопроса, чтобы понять, что человеку интересно.\n2. 2–3 уместных примера продукта или возможностей — не весь каталог сразу.\n3. Короткое объяснение сути без перегруза цифрами.\n4. Один понятный следующий шаг после встречи.\n\nСама презентация обычно укладывается примерно в 25–35 минут. В конце не оставляй разговор в воздухе: спроси, что человеку откликнулось и какой следующий шаг ему сейчас комфортен.`,
    };
  }

  if (PYRAMID_RE.test(userText)) {
    return {
      responseType: "answer",
      text: `Здесь лучше не спорить и не пытаться сразу доказать человеку, что он неправ. Сначала пойми, что именно он вкладывает в слово «пирамида».\n\nЯ бы ответил так:\n\n«Понимаю, почему такой вопрос возникает. Скажи, что именно тебя смущает больше всего: сама структура, необходимость приглашать людей или сомнение, что за системой стоит реальный продукт и товарооборот?»\n\nПосле его ответа уже разбирай именно конкретное сомнение, а не защищай весь сетевой бизнес сразу.`,
    };
  }

  if (PRICE_RE.test(userText)) {
    return {
      responseType: "answer",
      text: `Не убеждай человека, что сумма «небольшая», и не оправдывай цену наугад. Сначала выясни, что именно его останавливает.\n\nЯ бы написал так:\n\n«Понимаю. Скажи, тебя сейчас останавливает сама сумма или ты пока не видишь, за счёт чего такой старт имеет смысл?»\n\nПо ответу станет понятно, обсуждать ли сам формат старта или сначала вернуться к ценности и цели человека.`,
    };
  }

  if (THINK_RE.test(userText)) {
    return {
      responseType: "answer",
      text: `Фраза «мне надо подумать» сама по себе ещё ничего не объясняет. Не дави и не пытайся закрыть человека сразу.\n\nЯ бы ответил так:\n\n«Конечно. Чтобы я тебя не дёргал зря: что именно ты хочешь для себя обдумать — саму идею, продукт, формат партнёрства или финансовую сторону?»\n\nТак ты поймёшь реальную причину и сможешь продолжить разговор именно по ней.`,
    };
  }

  if (NO_TIME_RE.test(userText)) {
    return {
      responseType: "answer",
      text: `С «нет времени» лучше не спорить и не доказывать, что время можно найти. Нужно понять, что стоит за этой фразой.\n\nЯ бы написал так:\n\n«Понимаю, сейчас у многих плотный график. Скажи честно: тебя больше останавливает именно загрузка или ты пока просто не увидел для себя достаточного смысла выделять на это время?»\n\nОтвет сразу покажет, действительно ли проблема во времени.`,
    };
  }

  if (SLEEPING_PARTNER_RE.test(userText)) {
    return {
      responseType: "answer",
      text: `Со спящим партнёром я бы не начинал с плана, отчёта и вопроса «почему ничего не делаешь». Сначала верни нормальный человеческий контакт и убери ощущение вины.\n\nЯ бы написал так:\n\n«Привет! Давно нормально не общались. Не хочу тебя тормошить с отчётами — просто хочу понять, как ты сейчас и что больше всего выбило тебя из ритма?»\n\nСначала выясни причину выпадения. И только потом предложи один маленький шаг, который человеку реально сделать сейчас.`,
    };
  }

  if (NEWCOMER_STUCK_RE.test(userText)) {
    return {
      responseType: "answer",
      text: `Не давай новичку ещё один список задач, пока не понял, почему он остановился. Сначала нужна диагностика.\n\nЯ бы написал так:\n\n«Смотри, я не хочу сейчас наваливать на тебя новые задания. Скажи, что больше мешает начать: не знаешь кому писать, боишься отказа, не понимаешь что говорить или просто слишком много информации сразу?»\n\nПосле ответа выбери только один маленький следующий шаг под его реальную причину.`,
    };
  }

  if (FIRST_CONTACT_RE.test(userText)) {
    return {
      responseType: "clarification",
      text: `Чтобы первое сообщение не получилось искусственным, мне нужен один факт: откуда ты знаешь этого человека?\n\nНапример:\n• знакомы лично;\n• бывший коллега;\n• давно не общались;\n• увидел комментарий в группе;\n• подписан на него в соцсетях;\n• вообще не знакомы.`,
    };
  }

  return null;
}

async function ensureSchema(): Promise<void> {
  await pool.query(`ALTER TABLE jarvis_usage ADD COLUMN IF NOT EXISTS cooldown_started_at TIMESTAMPTZ`);
}

async function reserveFallbackAnswer(userId: number): Promise<Reserved> {
  await ensureSchema();
  const cx = await pool.connect();
  try {
    await cx.query("BEGIN");
    await cx.query(
      `INSERT INTO jarvis_usage (telegram_user_id) VALUES ($1)
       ON CONFLICT (telegram_user_id) DO NOTHING`,
      [userId],
    );
    const selected = await cx.query<QuotaRow>(
      `SELECT answers_used, locked_until, cooldown_started_at
       FROM jarvis_usage WHERE telegram_user_id=$1 FOR UPDATE`,
      [userId],
    );
    const row = selected.rows[0];
    const now = new Date();
    let used = Number(row?.answers_used || 0);

    if (used >= LIMIT) {
      const until = row?.locked_until ? new Date(row.locked_until) : null;
      if (until && until.getTime() > now.getTime()) {
        await cx.query("COMMIT");
        return { allowed: false, remaining: 0, lockedUntil: until };
      }
      used = 0;
    }

    const next = used + 1;
    const exhausted = next >= LIMIT;
    const lockedUntil = exhausted ? new Date(now.getTime() + COOLDOWN_MS) : null;
    await cx.query(
      `UPDATE jarvis_usage
       SET answers_used=$2,
           window_started_at=$3,
           cooldown_started_at=$3,
           locked_until=$4,
           updated_at=NOW()
       WHERE telegram_user_id=$1`,
      [userId, next, exhausted ? now : null, lockedUntil],
    );
    await cx.query("COMMIT");
    return { allowed: true, remaining: Math.max(0, LIMIT - next), lockedUntil };
  } catch (err) {
    await cx.query("ROLLBACK");
    throw err;
  } finally {
    cx.release();
  }
}

async function saveFallbackMessage(userId: number, text: string, counted: boolean): Promise<void> {
  await pool.query(
    `INSERT INTO jarvis_messages (telegram_user_id, role, content, message_type, counted)
     VALUES ($1,'assistant',$2,$3,$4)`,
    [userId, text, counted ? "answer" : "clarification", counted],
  );
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: TIME_ZONE,
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

async function sendLocked(bot: TelegramBot, chatId: number, userId: number, until: Date | null): Promise<void> {
  const profile = await pool.query<{ preferred_name: string | null }>(
    `SELECT preferred_name FROM jarvis_profiles WHERE telegram_user_id=$1`,
    [userId],
  );
  const name = profile.rows[0]?.preferred_name || "друг";
  const date = until || new Date(Date.now() + COOLDOWN_MS);
  await bot.sendMessage(
    chatId,
    `🔒 ${name}, бесплатные 20 полноценных ответов Джарвиса закончились.\n\nСледующие 20 ответов станут доступны ${formatDate(date)}.\n\nНе хочешь ждать? Переходи в Greenleaf Coach и работай на полную катушку — без ограничений.`,
    { reply_markup: { inline_keyboard: [[{ text: "Работать без ограничений в Greenleaf Coach →", url: APP_URL }]] } },
  );
}

function interceptTimeout(bot: TelegramBot, onTimeout: () => void): TelegramBot {
  return new Proxy(bot, {
    get(target, property, receiver) {
      if (property === "sendMessage") {
        return async (...args: SendMessageArgs) => {
          const [chatId, text, options] = args;
          if (TIMEOUT_COPY_RE.test(text)) {
            onTimeout();
            logger.info({ chatId }, "Jarvis v18 intercepted upstream AI timeout copy");
            return {} as any;
          }
          return target.sendMessage(chatId, text, options);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as TelegramBot;
}

export async function initJarvisV18(): Promise<void> {
  await initJarvisV17();
  await ensureSchema();
  logger.info("Jarvis v18 resilient timeout fallback ready");
}

export async function handleJarvisV18Message(bot: TelegramBot, msg: Message): Promise<void> {
  const userId = msg.from?.id;
  const userText = msg.text?.trim() || "";
  if (!userId || !userText || userText.startsWith("/")) {
    await handleJarvisV17Message(bot, msg);
    return;
  }

  let timedOut = false;
  const wrapped = interceptTimeout(bot, () => { timedOut = true; });
  await handleJarvisV17Message(wrapped, msg);
  if (!timedOut) return;

  const fallback = deterministicFallback(userText);
  if (!fallback) {
    await bot.sendMessage(
      msg.chat.id,
      "AI-провайдер сейчас отвечает нестабильно. Я остановил ожидание, чтобы не держать тебя минутами. Лимит не списан — повтори запрос чуть позже.",
    );
    return;
  }

  if (fallback.responseType === "clarification") {
    await saveFallbackMessage(userId, fallback.text, false);
    await bot.sendMessage(msg.chat.id, fallback.text);
    logger.info({ userId, fallback: "clarification" }, "Jarvis v18 served deterministic fallback");
    return;
  }

  const reserved = await reserveFallbackAnswer(userId);
  if (!reserved.allowed) {
    await sendLocked(bot, msg.chat.id, userId, reserved.lockedUntil);
    return;
  }

  await saveFallbackMessage(userId, fallback.text, true);
  await bot.sendMessage(msg.chat.id, fallback.text);

  if (reserved.remaining === 5) {
    await bot.sendMessage(msg.chat.id, "Осталось 5 бесплатных полноценных ответов Джарвиса. Наводящие вопросы лимит не расходуют.");
  } else if (reserved.remaining === 1) {
    await bot.sendMessage(msg.chat.id, "Остался 1 бесплатный полноценный ответ Джарвиса. После него начнётся 7-дневная пауза, затем снова будут доступны 20 ответов.");
  } else if (reserved.remaining === 0) {
    await sendLocked(bot, msg.chat.id, userId, reserved.lockedUntil);
  }

  logger.info({ userId, fallback: "answer", remaining: reserved.remaining }, "Jarvis v18 served deterministic fallback");
}

export async function handleJarvisV18Callback(bot: TelegramBot, query: CallbackQuery): Promise<void> {
  await handleJarvisV17Callback(bot, query);
}
