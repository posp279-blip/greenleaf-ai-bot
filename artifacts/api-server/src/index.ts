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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function initializeApplication(): Promise<void> {
  let attempt = 0;

  for (;;) {
    attempt += 1;

    try {
      logger.info({ attempt }, "Starting application background initialization");
      await syncDatabaseSchema();
      await startBot(webhookUrl);
      logger.info({ attempt }, "Application background initialization completed");
      return;
    } catch (err) {
      const retryDelayMs = Math.min(60_000, 5_000 * attempt);
      logger.error(
        { err, attempt, retryDelayMs },
        "Application initialization failed; HTTP healthcheck remains available and initialization will retry",
      );
      await sleep(retryDelayMs);
    }
  }
}

const server = app.listen(port, "0.0.0.0", () => {
  logger.info(
    { port, host: "0.0.0.0", publicAppUrl, webhookUrl },
    "Server listening",
  );

  void initializeApplication();
});

server.on("error", (err) => {
  logger.error({ err }, "Error listening on port");
  process.exit(1);
});
