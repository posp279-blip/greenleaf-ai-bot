import TelegramBot from "node-telegram-bot-api";
import { db } from "@workspace/db";
import { appSettingsTable, scenarioBlocksTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import {
  DEFAULT_V2_BLOCKS,
  type V2Block,
  type V2ContentKey,
  renderV2Text,
} from "./content-v2.js";

const CACHE_TTL_MS = 60_000;
const CONTENT_VERSION_KEY = "v2_content_version";
const CONTENT_VERSION = "greenleaf-fun-scenario-v1-2026-07-12";
const RUNTIME_COPY_MARK = Symbol.for("greenleaf.runtime-copy-installed");

const cache = new Map<V2ContentKey, { text: string; expiresAt: number }>();

type RuntimeReplacement = {
  needle: string;
  key: V2ContentKey;
};

const RUNTIME_REPLACEMENTS: RuntimeReplacement[] = [
  {
    needle: "Нажми кнопку «Начать» под приветствием — до этого момента я не буду запускать сценарий.",
    key: "runtime_intro_wait",
  },
  {
    needle: "После видео напиши, что бросилось в глаза: расход, состав, пена, выполаскивание или просто «понятно».",
    key: "runtime_laundry_video_prompt",
  },
  {
    needle: "Ок, без расчёта по стирке. Пойдём к средству для посуды?",
    key: "runtime_laundry_calc_skipped",
  },
  {
    needle: "После видео напиши, что заметил: расход, пена, смываемость или просто «норм, понятно».",
    key: "runtime_dish_video_prompt",
  },
  {
    needle: "Ок, без расчёта по посуде. Идём к следующей категории?",
    key: "runtime_dish_calc_skipped",
  },
  {
    needle: "После видео напиши, что показалось самым важным: комфорт, материалы, впитывание, воздухопроницаемость или просто «понятно».",
    key: "runtime_pads_video_prompt",
  },
  {
    needle: "Ок, без расчёта этой категории. Переходим к туалетной бумаге?",
    key: "runtime_pads_calc_skipped",
  },
  {
    needle: "После видео напиши, что заметил. Даже «не думал, что туалетную бумагу можно так разбирать» — нормальный ответ 😄",
    key: "runtime_toilet_video_prompt",
  },
  {
    needle: "Ок, без отдельного расчёта. Посмотрим весь домашний магазин за год?",
    key: "runtime_toilet_calc_skipped",
  },
  {
    needle: "Посмотрел? Напиши в двух словах, что думаешь, или просто «дальше».",
    key: "runtime_company_video_prompt",
  },
  {
    needle: "Напиши «да», если хочешь открыть условия, или «пока подумаю».",
    key: "runtime_final_answer_prompt",
  },
];

async function rewriteRuntimeText(text: string): Promise<string> {
  let result = text;

  for (const replacement of RUNTIME_REPLACEMENTS) {
    if (!result.includes(replacement.needle)) continue;
    result = result.replace(replacement.needle, await getV2Text(replacement.key));
  }

  return result;
}

function installRuntimeScenarioCopy(): void {
  const prototype = TelegramBot.prototype as unknown as {
    sendMessage: TelegramBot["sendMessage"];
    [RUNTIME_COPY_MARK]?: boolean;
  };

  if (prototype[RUNTIME_COPY_MARK]) return;
  prototype[RUNTIME_COPY_MARK] = true;

  const originalSendMessage = prototype.sendMessage;
  prototype.sendMessage = (async function (
    this: TelegramBot,
    chatId: Parameters<TelegramBot["sendMessage"]>[0],
    text: Parameters<TelegramBot["sendMessage"]>[1],
    options?: Parameters<TelegramBot["sendMessage"]>[2],
  ) {
    const rewritten = typeof text === "string" ? await rewriteRuntimeText(text) : text;
    return originalSendMessage.call(this, chatId, rewritten, options);
  }) as TelegramBot["sendMessage"];
}

function buildRows() {
  return Object.entries(DEFAULT_V2_BLOCKS).map(([key, rawBlock], index) => {
    const block: V2Block = rawBlock;
    return {
      key: `v2_${key}`,
      stage: block.stage,
      title: block.title,
      shortText: block.text,
      detailedText: null,
      order: block.order ?? index + 1,
      isActive: true,
    };
  });
}

async function getStoredContentVersion(): Promise<string> {
  const row = (await db
    .select({ value: appSettingsTable.value })
    .from(appSettingsTable)
    .where(eq(appSettingsTable.key, CONTENT_VERSION_KEY))
    .limit(1))[0];

  return row?.value || "";
}

export async function seedV2Content(): Promise<void> {
  installRuntimeScenarioCopy();

  const rows = buildRows();
  if (rows.length === 0) return;

  try {
    const storedVersion = await getStoredContentVersion();
    const needsFullRefresh = storedVersion !== CONTENT_VERSION;

    if (needsFullRefresh) {
      await db.transaction(async (tx) => {
        for (const row of rows) {
          await tx
            .insert(scenarioBlocksTable)
            .values(row)
            .onConflictDoUpdate({
              target: scenarioBlocksTable.key,
              set: {
                stage: row.stage,
                title: row.title,
                shortText: row.shortText,
                detailedText: null,
                order: row.order,
                isActive: true,
                updatedAt: new Date(),
              },
            });
        }

        await tx
          .insert(appSettingsTable)
          .values({ key: CONTENT_VERSION_KEY, value: CONTENT_VERSION })
          .onConflictDoUpdate({
            target: appSettingsTable.key,
            set: { value: CONTENT_VERSION, updatedAt: new Date() },
          });
      });

      clearV2ContentCache();
      logger.info(
        { blocks: rows.length, version: CONTENT_VERSION },
        "Greenleaf v2 content refreshed in admin database",
      );
      return;
    }

    await db
      .insert(scenarioBlocksTable)
      .values(rows)
      .onConflictDoNothing({ target: scenarioBlocksTable.key });

    logger.info(
      { blocks: rows.length, version: CONTENT_VERSION },
      "Greenleaf v2 content is ready; manual admin edits preserved",
    );
  } catch (err) {
    logger.error({ err }, "Failed to seed Greenleaf v2 content");
    throw err;
  }
}

export async function getV2Text(
  key: V2ContentKey,
  values: Record<string, string | number> = {},
): Promise<string> {
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) {
    return renderV2Text(cached.text, values);
  }

  const fallback = DEFAULT_V2_BLOCKS[key].text;
  try {
    const rows = await db
      .select({ shortText: scenarioBlocksTable.shortText, isActive: scenarioBlocksTable.isActive })
      .from(scenarioBlocksTable)
      .where(eq(scenarioBlocksTable.key, `v2_${key}`))
      .limit(1);

    const text = rows[0]?.isActive && rows[0].shortText ? rows[0].shortText : fallback;
    cache.set(key, { text, expiresAt: now + CACHE_TTL_MS });
    return renderV2Text(text, values);
  } catch (err) {
    logger.error({ err, key }, "Failed to load v2 scenario text; fallback used");
    return renderV2Text(fallback, values);
  }
}

export function clearV2ContentCache(): void {
  cache.clear();
}
