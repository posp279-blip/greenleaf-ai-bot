import { db } from "@workspace/db";
import { scenarioBlocksTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import {
  DEFAULT_V2_BLOCKS,
  type V2Block,
  type V2ContentKey,
  renderV2Text,
} from "./content-v2.js";

const CACHE_TTL_MS = 60_000;
const cache = new Map<V2ContentKey, { text: string; expiresAt: number }>();

export async function seedV2Content(): Promise<void> {
  const rows = Object.entries(DEFAULT_V2_BLOCKS).map(([key, rawBlock], index) => {
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

  if (rows.length === 0) return;

  try {
    await db
      .insert(scenarioBlocksTable)
      .values(rows)
      .onConflictDoNothing({ target: scenarioBlocksTable.key });
    logger.info({ blocks: rows.length }, "Greenleaf v2 content is ready");
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
