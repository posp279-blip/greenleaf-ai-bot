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

function normalizePublicUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function resolvePublicAppUrl(): string {
  const explicit = process.env.PUBLIC_APP_URL || "";
  if (explicit) return normalizePublicUrl(explicit);

  const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN || "";
  if (railwayDomain) return normalizePublicUrl(railwayDomain);

  // Compatibility fallback for any remaining Replit environments.
  const replitAppUrl = process.env.REPLIT_APP_URL || "";
  if (replitAppUrl) return normalizePublicUrl(replitAppUrl);

  const replitDomains = process.env.REPLIT_DOMAINS || "";
  const replitDomain = replitDomains.split(",")[0]?.trim() || process.env.REPLIT_DEV_DOMAIN || "";
  return normalizePublicUrl(replitDomain);
}

const publicAppUrl = resolvePublicAppUrl();
const webhookUrl = publicAppUrl ? `${publicAppUrl}/api/bot/webhook` : undefined;

app.listen(port, async (err?: Error) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port, publicAppUrl, webhookUrl }, "Server listening");
  await startBot(webhookUrl);
});
