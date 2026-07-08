export type Intent =
  | "user_name"
  | "user_refuses_name"
  | "mass_market_brand"
  | "eco_brand"
  | "unknown_brand"
  | "user_does_not_know"
  | "not_used"
  | "wants_short"
  | "wants_details"
  | "wants_video"
  | "wants_calculation"
  | "objection_price"
  | "objection_pyramid"
  | "health_question"
  | "income_question"
  | "price_question"
  | "wants_registration"
  | "soft_decline"
  | "hard_decline"
  | "off_topic"
  | "ready_for_next"
  | "affirmative"
  | "negative"
  | "question"
  | "other";

const MASS_MARKET_BRANDS = [
  "ariel", "tide", "persil", "losk", "ласка", "fairy", "aos", "zewa",
  "sorti", "biolan", "миф", "myth", "frosch", "bio-max", "domestos",
  "mr proper", "mrproper", "mr. proper", "mr.Proper", "mr Proper",
  "calgon", "lenor", "wipp", "wipe", "glorix", "comet", "ajax",
  "dove", "nivea", "palmolive", "colgate", "oral-b", "oral b",
];

const ECO_BRANDS = [
  "synergetic", "синергетик", "biomio", "biomiо", "bio mio",
  "amway", "эмвей", "экосфера", "экологика",
  "nature", "greenway", "гринвей", "grinway", "спивак",
  "sodasan", "sonett", "alma win", "alma-win",
];

export function classifyText(text: string): Intent {
  const lower = text.toLowerCase().trim();

  // Name refusal
  if (/(не хочу|без имени|потом|не скажу|зачем|не важно).*имя/.test(lower)
    || /^не хочу(ся)?$/.test(lower)
    || /^потом$/.test(lower)
    || /^без имени$/.test(lower)) {
    return "user_refuses_name";
  }

  // Name provision (single word, looks like a name)
  if (/^[a-zа-яё]+$/i.test(lower) && lower.length >= 2 && lower.length <= 15
    && !/^(ok|no|yes|ok|ok|da|net|go|aga|yes|no|ок|окей|да|нет|угу|ага|ладно|понял|ясно|го|конечно|согласен|согласна|хорошо|потом|не|yes|no|go|ok)$/.test(lower)) {
    return "user_name";
  }

  // Wants short
  if (/(^|)коротко|быстро|в двух словах|кратко|в кратце/.test(lower)) {
    return "wants_short";
  }

  // Wants details
  if (/(^|)подробнее|детально|подробно|поподробнее|весь текст|всё текст/.test(lower)) {
    return "wants_details";
  }

  // Wants video
  if (/(^|)видео|покажи видео|клип|ролик/.test(lower)) {
    return "wants_video";
  }

  if (/(не зна[fe])|(не помн[fe])|(не знаком)|(забыл)|(забыла)|(понятия не имею)/.test(lower)) {
    return "user_does_not_know";
  }
  if (/(не пользу[fe])|(не покупа)|(не нужно)|(не актуально)/.test(lower)) {
    return "not_used";
  }
  if (/(дорого)|(дорогов)|(не по карману)|(слишком дорог)/.test(lower)) {
    return "objection_price";
  }
  if (/(пирамид)|(развод)|(мошен)|(секта)|(мло[mn])|(сетевой)|(сетевик)|(лохотрон)/.test(lower)) {
    return "objection_pyramid";
  }
  if (/(^|)(хочу расчёт)|(покажи расчёт)|(сколько экономл)|(хочу цифры)|(сколько это выходит)|(покажи таблицу)/.test(lower)) {
    return "wants_calculation";
  }
  if (/(^|)(хочу зарегистр)|(хочу подключ)|(хочу вступ)|(хочу в greenleaf)|(хочу в грин)|(хочу открыть)|(хочу купить доступ)|(хочу открить условия)|(открить условия)/.test(lower)) {
    return "wants_registration";
  }
  if (/(^|)(сколько стоит)|(цена)|(стоимость)|(прайс)|(сколько это стоит)/.test(lower)) {
    return "price_question";
  }
  if (/(^|)(не интересно)|(не хочу)|(пока нет)|(не нужен)|(неактуально)|(мне это не надо)|(не для меня)/.test(lower)) {
    return "soft_decline";
  }
  if (/(^|)(отстань)|(отвали)|(больше не пиши)|(уйди)|(не надо мне это)|(не пиши мне)/.test(lower)) {
    return "hard_decline";
  }
  if (/(^|)(здоровье)|(болезнь)|(лечит)|(врач)|(диагноз)|(лечение)|(может ли вылечить)|(помогает ли)/.test(lower)) {
    return "health_question";
  }
  if (/(^|)(доход)|(заработок)|(сколько можно заработать)|(сколько платят)|(деньги)|(зарплата)|(прибыль)|(заработок в greenleaf)/.test(lower)) {
    return "income_question";
  }
  if (/(^|)(^да$|^ок$|^окей$|^хорошо$|^понял$|^понятно$|^давай$|^ладно$|^конечно$|^согласен$|^согласна$|^го$|^угу$|^ага$|^ясно$|yes$|yep$|sure$|go$)/.test(lower)) {
    return "affirmative";
  }
  if (/(^|)(^нет$|^не$|^неа$|^нее$|no$|nope$|nah$)/.test(lower)) {
    return "negative";
  }
  if (/(^|)дальше|перейдём|давай дальше|следующий шаг|погнали|вперёд/.test(lower)) {
    return "ready_for_next";
  }
  if (/(^|)зачем|куда|откуда|где|когда|кто|какой|какая|сколько|как|почему|зачем|что|что это|объясни|расскажи/.test(lower) || /\?/.test(lower)) {
    return "question";
  }

  for (const brand of ECO_BRANDS) {
    if (lower.includes(brand)) return "eco_brand";
  }
  for (const brand of MASS_MARKET_BRANDS) {
    if (lower.includes(brand)) return "mass_market_brand";
  }

  return "other";
}

export function detectBrandName(text: string): string | null {
  const lower = text.toLowerCase();
  const allBrands = [...MASS_MARKET_BRANDS, ...ECO_BRANDS];
  for (const brand of allBrands) {
    if (lower.includes(brand)) {
      return brand.charAt(0).toUpperCase() + brand.slice(1);
    }
  }
  return null;
}
