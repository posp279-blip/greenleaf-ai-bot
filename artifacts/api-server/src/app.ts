import { timingSafeEqual } from "node:crypto";
import express, { type Express, type Request, type Response } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes/index.js";
import { logger } from "./lib/logger.js";
import { handleWebhookUpdate } from "./bot/index.js";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser(process.env.SESSION_SECRET || ""));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function isValidWebhookSecret(req: Request): boolean {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (!expected) return true;

  const received = req.get("x-telegram-bot-api-secret-token") || "";
  const expectedBuffer = Buffer.from(expected, "utf8");
  const receivedBuffer = Buffer.from(received, "utf8");

  if (expectedBuffer.length !== receivedBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, receivedBuffer);
}

// Telegram webhook endpoint — must be BEFORE /api router to avoid auth/cors.
app.post("/api/bot/webhook", async (req: Request, res: Response) => {
  if (!isValidWebhookSecret(req)) {
    logger.warn({ ip: req.ip }, "Rejected Telegram webhook with invalid secret");
    res.sendStatus(403);
    return;
  }

  res.sendStatus(200); // Ack immediately so Telegram doesn't retry.
  try {
    await handleWebhookUpdate(req.body);
  } catch (err) {
    logger.error({ err }, "Webhook update handler error");
  }
});

app.use("/api", router);

export default app;
