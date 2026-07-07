import app from "./app.js";
import { logger } from "./lib/logger.js";
import { startBot } from "./bot/index.js";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const devDomain = process.env.REPLIT_DEV_DOMAIN || "";
const domains = process.env.REPLIT_DOMAINS || "";
const host = devDomain || domains.split(",")[0] || "";
const webhookUrl = host ? `https://${host}/api/bot/webhook` : undefined;

app.listen(port, async (err?: Error) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port, webhookUrl }, "Server listening");
  await startBot(webhookUrl);
});
