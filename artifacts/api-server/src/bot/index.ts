import axios from "axios";
import TelegramBot from "node-telegram-bot-api";
import type { Update } from "node-telegram-bot-api";
import { logger } from "../lib/logger.js";
import { handleMessage, handleCallback, handleAdminCallback } from "./engine-v2.js";
import { seedDatabase } from "./seed.js";
import { seedV2Content } from "./content-store-v2.js";
import { attachSavingsTableFormatter } from "./savings-table-format.js";
import { db } from "@workspace/db";
import { appSettingsTable } from "@workspace/db";

const UPDATE_DEDUP_TTL_MS = readPositiveInt(process.env.TELEGRAM_UPDATE_DEDUP_TTL_MS, 10 * 60_000);
const USER_MIN_INTERVAL_MS = readPositiveInt(process.env.TELEGRAM_USER_MIN_INTERVAL_MS, 500);
const TELEGRAM_VIDEO_MAX_BYTES = 49 * 1024 * 1024;
const processedUpdates = new Map<number, number>();
const userQueues = new Map<number, Promise<void>>();
const userLastHandledAt = new Map<number, number>();
const driveVideoSenders = new WeakSet<TelegramBot>();
const telegramVideoFileIds = new Map<string, string>();
const driveVideoDownloads = new Map<string, Promise<Buffer>>();
const GOOGLE_DRIVE_VIDEO_RE = /https:\/\/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]+)\/view(?:\?[^\s]*)?/iu;

let bot: TelegramBot | null = null;
let shutdownHandlersInstalled = false;

function readPositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isDuplicateUpdate(updateId: number): boolean {
  const now = Date.now();
  for (const [id, expiresAt] of processedUpdates) {
    if (expiresAt <= now) processedUpdates.delete(id);
  }

  if (processedUpdates.has(updateId)) return true;
  processedUpdates.set(updateId, now + UPDATE_DEDUP_TTL_MS);
  return false;
}

async function runForUser(userId: number, task: () => Promise<void>): Promise<void> {
  const previous = userQueues.get(userId) ?? Promise.resolve();
  let current: Promise<void>;

  current = previous
    .catch(() => undefined)
    .then(async () => {
      const lastHandledAt = userLastHandledAt.get(userId) ?? 0;
      const waitMs = Math.max(0, USER_MIN_INTERVAL_MS - (Date.now() - lastHandledAt));
      if (waitMs > 0) await sleep(waitMs);

      userLastHandledAt.set(userId, Date.now());
      await task();
    })
    .finally(() => {
      if (userQueues.get(userId) === current) userQueues.delete(userId);
      const lastHandledAt = userLastHandledAt.get(userId) ?? 0;
      if (Date.now() - lastHandledAt > UPDATE_DEDUP_TTL_MS) userLastHandledAt.delete(userId);
    });

  userQueues.set(userId, current);
  await current;
}

function attachBotErrorHandlers(instance: TelegramBot): void {
  instance.on("error", (err) => {
    logger.error({ err }, "Telegram bot error");
  });

  instance.on("webhook_error", (err) => {
    logger.error({ err }, "Telegram webhook error");
  });
}

function extractDriveVideo(text: string): { fileId: string; sourceUrl: string; caption: string } | null {
  const match = GOOGLE_DRIVE_VIDEO_RE.exec(text);
  if (!match?.[1] || match.index === undefined) return null;

  const prefix = text.slice(0, match.index);
  const marker = prefix.match(/🎬\s*$/u);
  const removeFrom = marker ? match.index - marker[0].length : match.index;
  const before = text.slice(0, removeFrom).trimEnd();
  const after = text.slice(match.index + match[0].length).trimStart();
  const caption = [before, after].filter(Boolean).join("\n\n").replace(/\n{3,}/g, "\n\n").trim();

  return {
    fileId: match[1],
    sourceUrl: match[0],
    caption,
  };
}

async function downloadGoogleDriveVideo(fileId: string): Promise<Buffer> {
  const existing = driveVideoDownloads.get(fileId);
  if (existing) return existing;

  const task = (async () => {
    const encodedId = encodeURIComponent(fileId);
    const urls = [
      `https://drive.usercontent.google.com/download?id=${encodedId}&export=download&confirm=t`,
      `https://drive.google.com/uc?export=download&confirm=t&id=${encodedId}`,
    ];
    let lastError: unknown;

    for (const url of urls) {
      try {
        const response = await axios.get<ArrayBuffer>(url, {
          responseType: "arraybuffer",
          timeout: 120_000,
          maxRedirects: 10,
          maxContentLength: TELEGRAM_VIDEO_MAX_BYTES,
          maxBodyLength: TELEGRAM_VIDEO_MAX_BYTES,
          headers: {
            Accept: "video/mp4,application/octet-stream;q=0.9,*/*;q=0.8",
            "User-Agent": "Mozilla/5.0 (compatible; GreenleafBot/1.0)",
          },
        });

        const buffer = Buffer.from(response.data);
        const contentType = String(response.headers["content-type"] || "").toLowerCase();
        const beginning = buffer.subarray(0, 256).toString("utf8").trimStart().toLowerCase();

        if (
          contentType.includes("text/html") ||
          beginning.startsWith("<!doctype html") ||
          beginning.startsWith("<html")
        ) {
          throw new Error("Google Drive returned an HTML page instead of the video file");
        }
        if (buffer.length === 0) throw new Error("Google Drive returned an empty file");
        if (buffer.length > TELEGRAM_VIDEO_MAX_BYTES) {
          throw new Error(`Video is too large for Telegram: ${buffer.length} bytes`);
        }

        logger.info({ fileId, bytes: buffer.length, contentType }, "Google Drive video downloaded");
        return buffer;
      } catch (err) {
        lastError = err;
        logger.warn({ err, fileId, url }, "Google Drive video download attempt failed");
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("Failed to download Google Drive video");
  })().finally(() => {
    driveVideoDownloads.delete(fileId);
  });

  driveVideoDownloads.set(fileId, task);
  return task;
}

function attachGoogleDriveVideoSender(instance: TelegramBot): void {
  if (driveVideoSenders.has(instance)) return;
  driveVideoSenders.add(instance);

  const originalSendMessage = instance.sendMessage.bind(instance);
  const originalSendVideo = instance.sendVideo.bind(instance);

  instance.sendMessage = (async (
    chatId: Parameters<TelegramBot["sendMessage"]>[0],
    text: Parameters<TelegramBot["sendMessage"]>[1],
    options?: Parameters<TelegramBot["sendMessage"]>[2],
  ) => {
    const video = extractDriveVideo(text);
    if (!video) return originalSendMessage(chatId, text, options);

    const messageOptions = options || {};
    const common = messageOptions as TelegramBot.SendMessageOptions & {
      message_thread_id?: number;
      protect_content?: boolean;
    };

    const sendVideo = async (caption: string | undefined, includeReplyMarkup: boolean) => {
      const videoOptions: TelegramBot.SendVideoOptions = {
        caption,
        parse_mode: common.parse_mode,
        disable_notification: common.disable_notification,
        reply_to_message_id: common.reply_to_message_id,
        reply_markup: includeReplyMarkup ? common.reply_markup : undefined,
        supports_streaming: true,
      };

      const cachedFileId = telegramVideoFileIds.get(video.fileId);
      if (cachedFileId) {
        try {
          return await originalSendVideo(chatId, cachedFileId, videoOptions);
        } catch (err) {
          telegramVideoFileIds.delete(video.fileId);
          logger.warn({ err, fileId: video.fileId }, "Cached Telegram video file_id failed; re-uploading");
        }
      }

      const buffer = await downloadGoogleDriveVideo(video.fileId);
      const sent = await originalSendVideo(
        chatId,
        buffer,
        videoOptions,
        { filename: `greenleaf-${video.fileId}.mp4`, contentType: "video/mp4" },
      );
      const fileId = sent.video?.file_id;
      if (fileId) telegramVideoFileIds.set(video.fileId, fileId);
      return sent;
    };

    try {
      if (video.caption.length <= 1024) {
        return await sendVideo(video.caption || undefined, true);
      }

      const sent = await sendVideo("🎬 Видео", false);
      await originalSendMessage(chatId, video.caption, messageOptions);
      return sent;
    } catch (err) {
      logger.error(
        { err, chatId, driveFileId: video.fileId, driveUrl: video.sourceUrl },
        "Failed to upload Google Drive video to Telegram; falling back to link",
      );
      return originalSendMessage(chatId, text, options);
    }
  }) as TelegramBot["sendMessage"];
}

function installShutdownHandlers(): void {
  if (shutdownHandlersInstalled) return;
  shutdownHandlersInstalled = true;

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Stopping Telegram bot");
    const currentBot = bot;
    bot = null;
    if (!currentBot) return;

    try {
      if (currentBot.isPolling()) await currentBot.stopPolling({ cancel: true });
    } catch (err) {
      logger.warn({ err }, "Failed to stop Telegram polling cleanly");
    }
  };

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

async function dispatchCallback(instance: TelegramBot, query: NonNullable<Update["callback_query"]>): Promise<void> {
  const data = query.data || "";
  if (
    data.startsWith("admin_") ||
    data.startsWith("lead_status_") ||
    data.startsWith("lead_to_partner_") ||
    data.startsWith("toggle_") ||
    data.startsWith("partner_leads_admin_")
  ) {
    await handleAdminCallback(instance, query);
  } else {
    await handleCallback(instance, query);
  }
}

export async function startBot(webhookUrl?: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    logger.warn("TELEGRAM_BOT_TOKEN not set — bot will not start");
    return;
  }

  await seedDatabase();
  await seedV2Content();
  installShutdownHandlers();

  bot = new TelegramBot(token, { polling: false, webHook: false });
  attachSavingsTableFormatter(bot);
  attachGoogleDriveVideoSender(bot);
  attachBotErrorHandlers(bot);

  try {
    const me = await bot.getMe();
    if (me.username) {
      await db
        .insert(appSettingsTable)
        .values({ key: "bot_username", value: me.username })
        .onConflictDoUpdate({
          target: appSettingsTable.key,
          set: { value: me.username, updatedAt: new Date() },
        });
      logger.info({ username: me.username }, "Bot username stored");
    }
  } catch (err) {
    logger.error({ err }, "Failed to get bot info");
  }

  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  let webhookConfigured = false;

  if (webhookUrl) {
    try {
      await bot.setWebHook(
        webhookUrl,
        webhookSecret ? { secret_token: webhookSecret } : undefined,
      );
      webhookConfigured = true;
      logger.info(
        { webhookUrl, protected: Boolean(webhookSecret) },
        "Telegram webhook set",
      );
      if (!webhookSecret) {
        logger.warn("TELEGRAM_WEBHOOK_SECRET is not set — webhook is not header-protected");
      }
    } catch (err) {
      logger.error({ err, webhookUrl }, "Failed to set webhook — falling back to polling");
    }
  }

  let webhookActive = false;
  try {
    const webhookInfo = await bot.getWebHookInfo();
    webhookActive = Boolean(
      webhookConfigured && webhookInfo.url && webhookInfo.url === webhookUrl,
    );
  } catch (err) {
    logger.error({ err }, "Failed to read Telegram webhook status");
  }

  if (!webhookActive) {
    if (webhookUrl) logger.warn("Webhook not active — falling back to polling");

    try {
      await bot.deleteWebHook({ drop_pending_updates: false });
      logger.info("Previous Telegram webhook removed before polling");
    } catch (err) {
      logger.error({ err }, "Failed to remove Telegram webhook before polling");
      throw err;
    }

    bot = new TelegramBot(token, { polling: true });
    attachSavingsTableFormatter(bot);
    attachGoogleDriveVideoSender(bot);
    attachBotErrorHandlers(bot);

    bot.on("message", async (msg) => {
      const userId = msg.from?.id;
      if (!userId) return;

      try {
        await runForUser(userId, () => handleMessage(bot!, msg));
      } catch (err) {
        logger.error({ err, chatId: msg.chat.id, userId }, "Error handling message");
        try {
          await bot!.sendMessage(msg.chat.id, "Что-то пошло не так. Попробуй ещё раз или нажми /start");
        } catch (sendErr) {
          logger.error({ err: sendErr, chatId: msg.chat.id }, "Failed to send fallback error message");
        }
      }
    });

    bot.on("callback_query", async (query) => {
      try {
        await runForUser(query.from.id, () => dispatchCallback(bot!, query));
      } catch (err) {
        logger.error({ err, userId: query.from.id }, "Error handling callback query");
      }
    });

    bot.on("polling_error", (err) => {
      logger.error({ err }, "Telegram polling error");
    });

    logger.info("Telegram bot started in polling mode");
  } else {
    logger.info("Telegram bot started in webhook mode");
  }
}

export function getBot(): TelegramBot | null {
  return bot;
}

export async function handleWebhookUpdate(update: Update): Promise<void> {
  const currentBot = getBot();
  if (!currentBot) {
    logger.warn("Bot not initialized — skipping webhook update");
    return;
  }

  if (isDuplicateUpdate(update.update_id)) {
    logger.info({ updateId: update.update_id }, "Duplicate Telegram update ignored");
    return;
  }

  try {
    if (update.message) {
      const userId = update.message.from?.id;
      if (!userId) return;
      await runForUser(userId, () => handleMessage(currentBot, update.message!));
    } else if (update.callback_query) {
      await runForUser(update.callback_query.from.id, () => dispatchCallback(currentBot, update.callback_query!));
    }
  } catch (err) {
    logger.error({ err, updateId: update.update_id }, "Error handling webhook update");
  }
}
