import type { Intent } from "./classifier.js";

export type FamilyProfile = {
  adults: number;
  children: number;
  femaleHygieneRelevant: boolean;
};

const REFUSAL_TO_NAME = /^(не хочу|без имени|не скажу|пропусти|аноним|неважно|нет)$/i;
const SKIP_PATTERN = /пропуст|без видео|не надо видео|дальше/i;
const EARNINGS_QUESTION = /сколько.*заработ|какой.*доход|сколько.*получ/i;
const CONTACT_PATTERN = /^(?:@?[a-zA-Z][a-zA-Z0-9_]{4,31}|\+?[0-9][0-9\s()\-]{7,20})$/;

export function isNameRefusal(text: string): boolean {
  return REFUSAL_TO_NAME.test(text.trim());
}

export function extractFirstName(text: string): string | null {
  if (isNameRefusal(text)) return null;
  const candidate = text.trim().split(/\s+/)[0]?.replace(/[^\p{L}\-']/gu, "") || "";
  return candidate.length >= 2 && candidate.length <= 40 ? candidate : null;
}

export function isAffirmative(intent: Intent, text: string): boolean {
  if (intent === "affirmative") return true;
  return /^(да|давай|ок|окей|покажи|интересно|разбер[её]м|разложи|ид[её]м|пойд[её]м|смотрим|норм|продолж)/i.test(text.trim());
}

export function isNegative(intent: Intent, text: string): boolean {
  if (intent === "negative" || intent === "soft_decline") return true;
  return /^(нет|не хочу|не надо|пока нет|стоп|отстань)/i.test(text.trim());
}

export function wantsToSkip(text: string): boolean {
  return SKIP_PATTERN.test(text.trim());
}

export function isEarningsQuestion(text: string): boolean {
  return EARNINGS_QUESTION.test(text.toLowerCase());
}

export function isAccidentalShortInput(text: string): boolean {
  const normalized = text.trim();
  return normalized.length <= 2 && !/^(да|ок|no)$/i.test(normalized);
}

export function parseFamilyProfile(text: string): FamilyProfile {
  const lower = text.toLowerCase();
  let adults = 0;
  let children = 0;

  const adultsMatch = lower.match(/(\d+)\s*(?:взросл|человек)/);
  const childrenMatch = lower.match(/(\d+)\s*(?:реб[её]н|дет)/);

  if (adultsMatch) adults = Number.parseInt(adultsMatch[1], 10);
  if (childrenMatch) children = Number.parseInt(childrenMatch[1], 10);

  const allNumbers = [...lower.matchAll(/\d+/g)].map((match) => Number.parseInt(match[0], 10));
  if (adults === 0 && children === 0 && allNumbers.length > 0) adults = allNumbers[0];
  if (adults === 0) adults = 1;

  adults = Math.min(Math.max(adults, 1), 10);
  children = Math.min(Math.max(children, 0), 10);

  const explicitNoFemale = /нет\s+(?:женщин|девуш|женской)|без\s+(?:женщин|девуш)/.test(lower);
  const explicitFemale = /есть\s+(?:женщин|девуш)|жена|девушка|дочь|мама|сестра|женская\s+гигиена\s+(?:да|актуальна)/.test(lower);

  return {
    adults,
    children,
    femaleHygieneRelevant: explicitFemale && !explicitNoFemale,
  };
}

export function isValidContact(text: string): boolean {
  return CONTACT_PATTERN.test(text.trim());
}

export function normalizeContact(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("@")) return trimmed;
  if (/^[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(trimmed)) return `@${trimmed}`;
  return trimmed.replace(/\s+/g, " ");
}
