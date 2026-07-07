import express, { type Express, type Request, type Response } from "express";
import cors from "cors";
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
app.use(cors());
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

app.use("/api", router);

export default app;
