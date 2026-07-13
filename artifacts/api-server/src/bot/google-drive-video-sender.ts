import axios from "axios";
import TelegramBot from "node-telegram-bot-api";
import { logger } from "../lib/logger.js";

const TELEGRAM_VIDEO_MAX_BYTES = 49 * 1024 * 1024;
const driveVideoSenders = new WeakSet<TelegramBot>();
const telegramVideoFileIds = new Map<string, string>();
const driveVideoDownloads = new Map<string, Promise<Buffer>>();
const GOOGLE_DRIVE_VIDEO_RE = /https:\/\/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]+)\/view(?:\?[^\s]*)?/iu;

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

export function attachGoogleDriveVideoSender(instance: TelegramBot): void {
  if (driveVideoSenders.has(instance)) return;
  driveVideoSenders.add(instance);

  const originalSendMessage = instance.sendMessage.bind(instance);
  const originalSendVideo = instance.sendVideo.bind(instance);

  instance.sendMessage = (async (
    chatId: Parameters<TelegramBot["sendMessage"]>[0],
    text: Parameters<TelegramBot["sendMessage"]>[1],
    options?: Parameters<TelegramBot["sendMessage"]>[2],
  ) => {
    const numericChatId = Number(chatId);
    if (Number.isSafeInteger(numericChatId) && numericChatId < 0) {
      return originalSendMessage(chatId, text, options);
    }

    const video = extractDriveVideo(text);
    if (!video) return originalSendMessage(chatId, text, options);

    const messageOptions = options || {};
    const common = messageOptions as TelegramBot.SendMessageOptions;

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
