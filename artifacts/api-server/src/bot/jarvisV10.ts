import TelegramBot from "node-telegram-bot-api";
import type { CallbackQuery, Message } from "node-telegram-bot-api";
import { logger } from "../lib/logger.js";
import { handleJarvisV9Message, handleJarvisV9Callback, initJarvisV9 } from "./jarvisV9.js";

const SOURCE_RE = /(?:\(?\[?SOURCE\s*\d+(?:\s*[:#-]\s*[A-Za-z0-9_.:-]+)?\]?\)?)/giu;
const PLACEHOLDER_RE = /\[[^\]]{1,80}\]|\{[^}]{1,80}\}|<[^>]{1,80}>/gu;
const WARM_COLLEAGUE_RE = /(?:бывш(?:ая|ей|ую)?\s+коллег|коллег(?:а|ой|у)).{0,120}(?:давно|год|лет|не\s+общ)|(?:давно|год|лет|не\s+общ).{0,120}(?:бывш(?:ая|ей|ую)?\s+коллег|коллег(?:а|ой|у))/iu;
const READY_REQUEST_RE = /(?:как\s+написать|что\s+написать|напиши\s+(?:сообщение|ответ)|что\s+ответить|без\s+резкого\s+захода)/iu;
const PRICE_PYRAMID_RE = /(?=.*(?:дорог|цен|сумм))(?=.*пирамид)/iu;
const PRESENTATION_FOLLOWUP_RE = /(?=.*(?:вчера|после))(?=.*презентац)(?=.*(?:что\s+написать|написать\s+сегодня|решени))/iu;
const EXACT_FACT_RE = /(?:точн|официальн).*(?:выручк|оборот|отч[её]т|статистик|цифр)/iu;
const GUARANTEE_REQUEST_RE = /(?:точно\s+вылеч|гарантир.*(?:заработ|доход|леч)|точно.*(?:заработ|излеч))/iu;
const LOCK_OR_SYSTEM_RE = /^(?:🔒|Осталось\s+\d+|Остался\s+\d+|Доступно\s+\d+|Привет\s*👋|Контекст очищен|Хорошо\. Как мне|Сейчас не получилось|Что-то пошло не так)/iu;

type SendMessageArgs = Parameters<TelegramBot["sendMessage"]>;

function normalize(text: string): string {
  return text
    .replace(SOURCE_RE, "")
    .replace(/\[\s*(?:Имя|имя)\s*\]/gu, "")
    .replace(/\[\s*(?:тема|тема\/область|ваша\s+сфера)\s*\]/giu, "эта тема")
    .replace(PLACEHOLDER_RE, "")
    .replace(/\bзаработн(?:ая|ой)\s+плат[аы]\b/giu, "возможность дохода")
    .replace(/\bваканси[яюи]\b/giu, "возможность")
    .replace(/\bпозици[яюи]\b/giu, "формат")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .trim();
}

function warmFallback(): string {
  return `Здесь я бы вообще не заходил сразу с Greenleaf. После двух лет паузы сначала лучше просто восстановить человеческий контакт.\n\nЯ бы написал так:\n\n«Привет! Давно не общались 🙂 Решил написать и узнать, как ты. Как у тебя дела, чем сейчас занимаешься?»\n\nЕсли разговор пойдёт легко, сначала нормально пообщайся. К Greenleaf переходи только когда появится естественный контекст, а не во втором сообщении.`;
}

function pricePyramidFallback(): string {
  return `Здесь сразу два возражения — сумма старта и недоверие к самой модели. Я бы не спорил ни с одним из них и не пытался всё доказать одним сообщением.\n\nМожно ответить так:\n\n«Понимаю тебя. Тут, по сути, два разных вопроса: сама сумма старта и ощущение, что система похожа на пирамиду. По сумме хочу понять — для тебя сейчас велика сама цифра или пока не видна ценность такого старта? А по “пирамиде” я бы тоже не отмахивался: в Greenleaf есть реальный продукт и товарооборот, но лучше спокойно разобрать, что именно в модели вызывает у тебя такое ощущение. Что из этих двух моментов сейчас сильнее тормозит?»\n\nПо ответу уже разбирай одно возражение за раз.`;
}

function followupFallback(): string {
  return `Я бы сегодня не повторял презентацию и не спрашивал просто «ну что решил?». Лучше вернуть человека к тому, что его реально зацепило.\n\nНапиши так:\n\n«Привет! Спасибо за вчерашний разговор. Ты сказал, что тебе интересно, поэтому хочу понять: что больше всего откликнулось, а что пока оставило вопрос? Если удобно, можем коротко созвониться и разобрать только этот момент».\n\nТак ты продолжаешь вчерашний диалог без давления и получаешь конкретную тему для следующего контакта.`;
}

function exactFactFallback(): string {
  return `В моей подтверждённой базе Greenleaf нет данных, по которым я могу точно назвать этот показатель за 2026 год или дать проверенную ссылку на официальный отчёт. Не хочу придумывать цифру или источник. Если нужен именно официальный факт, лучше сверить его с актуальным официальным материалом компании.`;
}

function guaranteeFallback(): string {
  return `Так писать нельзя: я не буду обещать человеку гарантированное лечение или гарантированный доход. Для таких утверждений у меня нет подтверждённого основания.\n\nМожно говорить только проверяемо и честно: о конкретных свойствах продукта — если они подтверждены официальным описанием, а о бизнесе — что результат зависит от действий человека и не гарантируется.`;
}

function postGuard(userText: string, outgoing: string): { text: string; reason?: string } {
  if (!userText || userText.startsWith("/") || LOCK_OR_SYSTEM_RE.test(outgoing)) {
    return { text: normalize(outgoing) };
  }

  const cleaned = normalize(outgoing);

  if (GUARANTEE_REQUEST_RE.test(userText)) {
    return { text: guaranteeFallback(), reason: "safety_guarantee" };
  }
  if (EXACT_FACT_RE.test(userText) && !/(?:подтвержд[её]нн.*баз|нет.*данн|не\s+могу.*точн|нет.*подтверж)/iu.test(cleaned)) {
    return { text: exactFactFallback(), reason: "unknown_exact_fact" };
  }
  if (WARM_COLLEAGUE_RE.test(userText) && READY_REQUEST_RE.test(userText) && (!/[«"][^»"\n]{18,}[»"]/u.test(cleaned) || /\[[^\]]+\]/u.test(outgoing))) {
    return { text: warmFallback(), reason: "warm_colleague_ready_message" };
  }
  if (PRICE_PYRAMID_RE.test(userText) && (!/пирамид/iu.test(cleaned) || !/(?:дорог|цен|сумм)/iu.test(cleaned))) {
    return { text: pricePyramidFallback(), reason: "combined_objections" };
  }
  if (PRESENTATION_FOLLOWUP_RE.test(userText) && !/[«"][^»"\n]{18,}[»"]/u.test(cleaned)) {
    return { text: followupFallback(), reason: "presentation_followup" };
  }

  return { text: cleaned, reason: cleaned !== outgoing ? "sanitize" : undefined };
}

function wrapBot(bot: TelegramBot, userText: string): TelegramBot {
  return new Proxy(bot, {
    get(target, property, receiver) {
      if (property === "sendMessage") {
        return async (...args: SendMessageArgs) => {
          const [chatId, text, options] = args;
          const guarded = postGuard(userText, text);
          if (guarded.reason) logger.info({ reason: guarded.reason }, "Jarvis v10 post-guard applied");
          return target.sendMessage(chatId, guarded.text, options);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as TelegramBot;
}

export async function initJarvisV10(): Promise<void> {
  await initJarvisV9();
  logger.info("Jarvis v10 deterministic release post-guard ready");
}

export async function handleJarvisV10Message(bot: TelegramBot, msg: Message): Promise<void> {
  const userText = msg.text?.trim() || "";
  await handleJarvisV9Message(wrapBot(bot, userText), msg);
}

export async function handleJarvisV10Callback(bot: TelegramBot, query: CallbackQuery): Promise<void> {
  await handleJarvisV9Callback(bot, query);
}
