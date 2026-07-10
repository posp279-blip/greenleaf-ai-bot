import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import http, { type IncomingMessage, type ServerResponse } from "node:http";

process.env.TZ = process.env.TZ?.trim() || "Europe/Moscow";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
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

  const replitAppUrl = process.env.REPLIT_APP_URL || "";
  if (replitAppUrl) return normalizePublicUrl(replitAppUrl);

  const replitDomains = process.env.REPLIT_DOMAINS || "";
  const replitDomain =
    replitDomains.split(",")[0]?.trim() || process.env.REPLIT_DEV_DOMAIN || "";
  return normalizePublicUrl(replitDomain);
}

function sanitizeDiagnostic(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value);
  return raw
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "postgresql://***")
    .replace(/https:\/\/api\.telegram\.org\/bot[^/\s]+/gi, "https://api.telegram.org/bot***")
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "***")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800);
}

const publicAppUrl = resolvePublicAppUrl();
const webhookUrl = publicAppUrl ? `${publicAppUrl}/api/bot/webhook` : undefined;
const dbDirectory = fileURLToPath(new URL("../../../lib/db/", import.meta.url));

let phase = "booting";
let initializationAttempt = 0;
let lastInitializationError: string | null = null;
let nextRetryInMs: number | null = null;
let applicationHandler:
  | ((req: IncomingMessage, res: ServerResponse) => void)
  | null = null;

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(payload));
  res.end(payload);
}

const server = http.createServer((req, res) => {
  const pathname = (req.url || "/").split("?")[0];

  if (pathname === "/api/healthz" || pathname === "/healthz" || pathname === "/") {
    writeJson(res, 200, {
      status: "ok",
      phase,
      attempt: initializationAttempt,
      lastError: lastInitializationError,
      nextRetryInMs,
    });
    return;
  }

  if (applicationHandler) {
    applicationHandler(req, res);
    return;
  }

  writeJson(res, 503, { error: "application is starting", phase });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function syncDatabaseSchema(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    return Promise.reject(new Error("DATABASE_URL is missing in the Railway application process"));
  }

  return new Promise((resolve, reject) => {
    console.log("[startup] Synchronizing PostgreSQL schema via direct Drizzle CLI credentials");

    const child = spawn(
      "pnpm",
      [
        "exec",
        "drizzle-kit",
        "push",
        "--dialect=postgresql",
        "--schema=./src/schema/index.ts",
        `--url=${databaseUrl}`,
        "--force",
      ],
      {
        cwd: dbDirectory,
        env: { ...process.env, DATABASE_URL: databaseUrl },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let diagnosticOutput = "";
    const appendDiagnostic = (chunk: Buffer): void => {
      const text = chunk.toString("utf8");
      diagnosticOutput = `${diagnosticOutput}${text}`.slice(-6000);
    };

    child.stdout?.on("data", appendDiagnostic);
    child.stderr?.on("data", appendDiagnostic);

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(
        new Error(
          `PostgreSQL schema synchronization timed out after 120 seconds. ${sanitizeDiagnostic(diagnosticOutput)}`,
        ),
      );
    }, 120_000);

    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) {
        console.log("[startup] PostgreSQL schema synchronization completed");
        resolve();
        return;
      }

      const details = sanitizeDiagnostic(diagnosticOutput);
      reject(
        new Error(
          `PostgreSQL schema synchronization exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}${details ? `: ${details}` : ""}`,
        ),
      );
    });
  });
}

async function initializeApplication(): Promise<void> {
  for (;;) {
    initializationAttempt += 1;
    nextRetryInMs = null;
    lastInitializationError = null;

    try {
      phase = "loading_application";
      console.log(`[startup] Loading application, attempt ${initializationAttempt}`);

      const [{ default: app }, { startBot }] = await Promise.all([
        import("./app.js"),
        import("./bot/index.js"),
      ]);

      applicationHandler = (req, res) => app(req, res);
      phase = "synchronizing_database";
      await syncDatabaseSchema();

      phase = "starting_bot";
      await startBot(webhookUrl);

      phase = "ready";
      lastInitializationError = null;
      nextRetryInMs = null;
      console.log("[startup] Application initialization completed");
      return;
    } catch (error) {
      const retryDelayMs = Math.min(60_000, 5_000 * initializationAttempt);
      phase = "initialization_retry";
      lastInitializationError = sanitizeDiagnostic(error);
      nextRetryInMs = retryDelayMs;
      console.error(
        `[startup] Initialization attempt ${initializationAttempt} failed; retrying in ${retryDelayMs} ms`,
        sanitizeDiagnostic(error),
      );
      await sleep(retryDelayMs);
    }
  }
}

server.listen(port, "0.0.0.0", () => {
  console.log(
    `[startup] Health server listening on 0.0.0.0:${port}; publicAppUrl=${publicAppUrl || "(none)"}`,
  );
  void initializeApplication();
});

server.on("error", (error) => {
  console.error("[startup] HTTP server error", error);
  process.exit(1);
});