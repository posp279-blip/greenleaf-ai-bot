import express, { type Express, type Request, type Response } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes/index.js";
import { logger } from "./lib/logger.js";
import { handleWebhookUpdate } from "./bot/index.js";
import { getJarvisSitePublicKeyB64 } from "./bot/jarvisSiteIdentity.js";

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

// Telegram webhook endpoint — must be BEFORE /api router to avoid auth/cors
app.post("/api/bot/webhook", async (req: Request, res: Response) => {
  res.sendStatus(200); // Ack immediately so Telegram doesn't retry
  try {
    await handleWebhookUpdate(req.body);
  } catch (err) {
    logger.error({ err }, "Webhook update handler error");
  }
});

// Public verification key for Greenleaf Select. The private key never leaves Jarvis PostgreSQL.
app.get("/api/bot/site-integration-public-key", async (_req: Request, res: Response) => {
  try {
    const publicKey = await getJarvisSitePublicKeyB64();
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.json({ algorithm: "Ed25519", publicKey });
  } catch (err) {
    logger.error({ err }, "Failed to expose Jarvis site integration public key");
    res.status(503).json({ error: "integration key unavailable" });
  }
});

app.use("/api", router);

export default app;
