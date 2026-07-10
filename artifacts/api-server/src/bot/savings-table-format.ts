import TelegramBot from "node-telegram-bot-api";

const formattedBots = new WeakSet<TelegramBot>();

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function categoryIcon(category: string): string {
  const normalized = category.toLowerCase();

  if (/стир|белья/.test(normalized)) return "🧺";
  if (/кондиционер/.test(normalized)) return "🫧";
  if (/парфюм/.test(normalized)) return "🌸";
  if (/посуд/.test(normalized)) return "🍽";
  if (/шампун/.test(normalized)) return "🧴";
  if (/бальзам/.test(normalized)) return "💆";
  if (/душ/.test(normalized)) return "🚿";
  if (/паст/.test(normalized)) return "🪥";
  if (/мыло/.test(normalized)) return "🧼";
  if (/крем/.test(normalized)) return "🤲";
  if (/кухн/.test(normalized)) return "✨";
  if (/женск|гигиен/.test(normalized)) return "🌷";
  if (/туалет|бумаг/.test(normalized)) return "🧻";

  return "▫️";
}

function normalizeMoney(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

type ParsedRow = {
  category: string;
  mass: string;
  green: string;
  saving: string;
};

function parseRow(line: string): ParsedRow | null {
  const match = line.match(
    /^(.+?):\s*([\d\s\u00a0]+)\s*\/\s*([\d\s\u00a0]+)\s*\/\s*([\d\s\u00a0]+)\s*₽$/u,
  );

  if (!match) return null;

  return {
    category: match[1]?.trim() || "Категория",
    mass: normalizeMoney(match[2] || "0"),
    green: normalizeMoney(match[3] || "0"),
    saving: normalizeMoney(match[4] || "0"),
  };
}

function formatSavingsTable(text: string): string | null {
  if (!text.startsWith("📊 Таблица: масс-маркет / Greenleaf / разница")) {
    return null;
  }

  const rows: ParsedRow[] = [];
  let totals: ParsedRow | null = null;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("ИТОГО:")) {
      totals = parseRow(line.replace(/^ИТОГО:/, "Итого:"));
      continue;
    }

    const row = parseRow(line);
    if (row && row.category !== "Итого") rows.push(row);
  }

  if (!rows.length || !totals) return null;

  const sections = rows.map((row) => {
    const icon = categoryIcon(row.category);
    return [
      `<b>${icon} ${escapeHtml(row.category)}</b>`,
      `🏪 Масс-маркет: <b>${escapeHtml(row.mass)} ₽</b>`,
      `🌿 Greenleaf: <b>${escapeHtml(row.green)} ₽</b>`,
      `💰 Экономия: <b>${escapeHtml(row.saving)} ₽</b>`,
    ].join("\n");
  });

  return [
    "<b>📊 СРАВНЕНИЕ РАСХОДОВ ЗА ГОД</b>",
    "",
    "По каждой категории отдельно:",
    "",
    ...sections.flatMap((section) => [section, ""]),
    "━━━━━━━━━━━━━━",
    "<b>ИТОГО ЗА ГОД</b>",
    `🏪 Масс-маркет: <b>${escapeHtml(totals.mass)} ₽</b>`,
    `🌿 Greenleaf: <b>${escapeHtml(totals.green)} ₽</b>`,
    `💰 Экономия семьи: <b>${escapeHtml(totals.saving)} ₽</b>`,
    "",
    "<i>Расчёт примерный и зависит от расхода и актуальных цен.</i>",
  ].join("\n");
}

export function attachSavingsTableFormatter(instance: TelegramBot): void {
  if (formattedBots.has(instance)) return;
  formattedBots.add(instance);

  const originalSendMessage = instance.sendMessage.bind(instance);

  instance.sendMessage = ((
    chatId: Parameters<TelegramBot["sendMessage"]>[0],
    text: Parameters<TelegramBot["sendMessage"]>[1],
    options?: Parameters<TelegramBot["sendMessage"]>[2],
  ) => {
    const formatted = formatSavingsTable(text);
    if (!formatted) return originalSendMessage(chatId, text, options);

    return originalSendMessage(chatId, formatted, {
      ...options,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  }) as TelegramBot["sendMessage"];
}
