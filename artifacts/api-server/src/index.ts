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

// Public host resolution for Railway first, then the legacy Replit variables.
const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN || "";
const appUrl = process.env.REPLIT_APP_URL || "";
const devDomain = process.env.REPLIT_DEV_DOMAIN || "";
const domains = process.env.REPLIT_DOMAINS || "";
const host =
  railwayDomain ||
  appUrl.replace(/^https?:\/\//, "") ||
  domains.split(",")[0] ||
  devDomain ||
  "";
const webhookUrl = host ? `https://${host}/api/bot/webhook` : undefined;

app.listen(port, async (err?: Error) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port, webhookUrl }, "Server listening");
  await startBot(webhookUrl);

  // Local self-check. Harmless on Railway and keeps compatibility with the old runtime.
  const keepAliveUrl = `http://localhost:${port}/api/healthz`;
  setInterval(() => {
    fetch(keepAliveUrl).catch(() => {
      // Ignore errors — platform health/restart policy handles process failures.
    });
  }, 45_000);
  logger.info({ url: keepAliveUrl, intervalSec: 45 }, "Local health ping started");
});
