import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
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

function syncDatabaseSchema(): Promise<void> {
  const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));

  return new Promise((resolve, reject) => {
    logger.info({ workspaceRoot }, "Starting PostgreSQL schema synchronization");

    const child = spawn(
      "pnpm",
      ["--dir", workspaceRoot, "--filter", "@workspace/db", "run", "push-force"],
      {
        cwd: workspaceRoot,
        env: process.env,
        stdio: "inherit",
      },
    );

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("PostgreSQL schema synchronization timed out after 120 seconds"));
    }, 120_000);

    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) {
        logger.info("PostgreSQL schema synchronization completed");
        resolve();
        return;
      }

      reject(
        new Error(
          `PostgreSQL schema synchronization exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}`,
        ),
      );
    });
  });
}

const publicAppUrl = resolvePublicAppUrl();
const webhookUrl = publicAppUrl ? `${publicAppUrl}/api/bot/webhook` : undefined;

const server = app.listen(port, () => {
  logger.info({ port, publicAppUrl, webhookUrl }, "Server listening");

  void (async () => {
    await syncDatabaseSchema();
    await startBot(webhookUrl);
  })().catch((err) => {
    logger.error({ err }, "Application initialization failed after HTTP server startup");
    server.close(() => process.exit(1));
  });
});

server.on("error", (err) => {
  logger.error({ err }, "Error listening on port");
  process.exit(1);
});
