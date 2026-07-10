import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL?.trim();

if (!databaseUrl) {
  console.error("[railway-start] DATABASE_URL is missing");
  process.exit(1);
}

let parsedUrl;
try {
  parsedUrl = new URL(databaseUrl);
} catch {
  console.error("[railway-start] DATABASE_URL is not a valid PostgreSQL URL");
  process.exit(1);
}

console.log(
  `[railway-start] PostgreSQL target host=${parsedUrl.hostname} port=${parsedUrl.port || "5432"} database=${parsedUrl.pathname.replace(/^\//, "") || "(default)"}`,
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let connected = false;
let lastError;

for (let attempt = 1; attempt <= 10; attempt += 1) {
  const client = new Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 10_000,
  });

  try {
    await client.connect();
    await client.query("select 1");
    await client.end();
    connected = true;
    console.log(`[railway-start] PostgreSQL connection successful on attempt ${attempt}`);
    break;
  } catch (error) {
    lastError = error;
    try {
      await client.end();
    } catch {
      // Ignore cleanup failures after a failed connection.
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[railway-start] PostgreSQL attempt ${attempt}/10 failed: ${message}`);
    if (attempt < 10) await sleep(3_000);
  }
}

if (!connected) {
  const message = lastError instanceof Error ? lastError.message : String(lastError || "unknown error");
  console.error(`[railway-start] PostgreSQL is unavailable: ${message}`);
  process.exit(1);
}

const dbDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(dbDir, "../..");

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    console.log(`[railway-start] Running: ${command} ${args.join(" ")}`);
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: "inherit",
    });

    const forwardSignal = (signal) => {
      if (!child.killed) child.kill(signal);
    };
    process.once("SIGTERM", forwardSignal);
    process.once("SIGINT", forwardSignal);

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      process.removeListener("SIGTERM", forwardSignal);
      process.removeListener("SIGINT", forwardSignal);
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}`));
    });
  });
}

try {
  await run("pnpm", ["--filter", "@workspace/db", "run", "push-force"], workspaceRoot);
  console.log("[railway-start] Database schema is ready");
  await run("pnpm", ["--filter", "@workspace/api-server", "run", "start"], workspaceRoot);
} catch (error) {
  console.error("[railway-start] Startup failed:", error instanceof Error ? error.message : error);
  process.exit(1);
}
