export type Intent =
  | "mass_market_brand"
  | "eco_brand"
  | "unknown"
  | "not_used"
  | "objection_price"
  | "objection_pyramid"
  | "wants_calculation"
  | "wants_registration"
  | "price_question"
  | "soft_decline"
  | "affirmative"
  | "negative"
  | "question"
  | "other";

const MASS_MARKET_BRANDS = [
  "ariel",
  "tide",
  "persil",
  "losk",
  "ласка",
  "fairy",
  "aos",
  "zewa",
  "sorti",
  "biolan",
  "миф",
  "myth",
  "frosch",
  "bio-max",
];

const ECO_BRANDS = [
  "synergetic",
  "синергетик",
  "biomio",
  "biomiо",
  "bio mio",
  "amway",
  "эмвей",
  "экосфера",
  "экологика",
  "nature",
  "greenway",
];

export function classifyText(text: string): Intent {
  const lower = text.toLowerCase().trim();

  if (
    /не зна[юе]|не помн[юи]|не знаком|забыл|забыла|понятия не имею/.test(lower)
  ) {
    return "unknown";
  }
  if (/не пользу[юе]|не покупа|не нужно|не актуально/.test(lower)) {
    return "not_used";
  }
  if (/дорого|дорогов|не по карману|слишком дорог/.test(lower)) {
    return "objection_price";
  }
  if (
    /пирамид|развод|мошен|секта|мло[мн]|сетевой|сетевик|лохотрон/.test(lower)
  ) {
    return "objection_pyramid";
  }
  if (/хочу расч[её]т|покажи расч[её]т|сколько экономл|хочу цифры/.test(lower)) {
    return "wants_calculation";
  }
  if (
    /хочу зарегистр|хочу подключ|хочу вступ|хочу в greenleaf|хочу в грин|хочу открыть|хочу купить доступ/.test(
      lower
    )
  ) {
    return "wants_registration";
  }
  if (/сколько стоит|цена|стоимость|прайс/.test(lower)) {
    return "price_question";
  }
  if (/не интересно|не хочу|пока нет|не нужен|неактуально/.test(lower)) {
    return "soft_decline";
  }
  if (/^(да|ок|окей|хорошо|понял|понятно|давай|ладно|конечно|согласен|согласна|го|aga|yes|угу|ага|ясно)\s*[!.]*$/.test(lower)) {
    return "affirmative";
  }
  if (/^(нет|не|no|нее|неа)\s*[!.]*$/.test(lower)) {
    return "negative";
  }
  if (/\?/.test(lower) || /как|почему|зачем|что это|объясни/.test(lower)) {
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
