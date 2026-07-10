import { createHash, timingSafeEqual } from "node:crypto";
import { Router, type CookieOptions } from "express";
import { logger } from "../lib/logger.js";

const router = Router();
const COOKIE_NAME = "admin_auth";
const LOGIN_WINDOW_MS = 15 * 60_000;
const MAX_LOGIN_ATTEMPTS = 5;
const attemptsByIp = new Map<string, { count: number; resetAt: number }>();

const cookieOptions: CookieOptions = {
  signed: true,
  httpOnly: true,
  maxAge: 7 * 24 * 60 * 60 * 1000,
  sameSite: "strict",
  secure: process.env.NODE_ENV === "production",
  path: "/api/admin",
};

function getClientIp(req: Parameters<typeof router.post>[1] extends never ? never : any): string {
  return req.ip || req.socket?.remoteAddress || "unknown";
}

function getAuthConfig(): { password: string; sessionSecret: string } | null {
  const password = process.env.ADMIN_PASSWORD || "";
  const sessionSecret = process.env.SESSION_SECRET || "";
  if (!password || !sessionSecret) return null;
  return { password, sessionSecret };
}

function secureEquals(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left, "utf8").digest();
  const rightHash = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftHash, rightHash);
}

function getAttemptState(ip: string): { count: number; resetAt: number } {
  const now = Date.now();
  const current = attemptsByIp.get(ip);
  if (!current || current.resetAt <= now) {
    const fresh = { count: 0, resetAt: now + LOGIN_WINDOW_MS };
    attemptsByIp.set(ip, fresh);
    return fresh;
  }
  return current;
}

router.post("/login", (req, res) => {
  const config = getAuthConfig();
  if (!config) {
    logger.error("ADMIN_PASSWORD or SESSION_SECRET is missing");
    res.status(503).json({ error: "Админка временно недоступна" });
    return;
  }

  const ip = getClientIp(req);
  const attempts = getAttemptState(ip);
  if (attempts.count >= MAX_LOGIN_ATTEMPTS) {
    const retryAfterSeconds = Math.max(1, Math.ceil((attempts.resetAt - Date.now()) / 1000));
    res.setHeader("Retry-After", String(retryAfterSeconds));
    res.status(429).json({ error: "Слишком много попыток. Попробуйте позже" });
    return;
  }

  const { password } = req.body as { password?: string };
  if (!password || !secureEquals(password, config.password)) {
    attempts.count += 1;
    attemptsByIp.set(ip, attempts);
    res.status(401).json({ error: "Неверный пароль" });
    return;
  }

  attemptsByIp.delete(ip);
  res.cookie(COOKIE_NAME, "1", cookieOptions);
  res.json({ success: true });
});

router.post("/logout", (_req, res) => {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: cookieOptions.httpOnly,
    sameSite: cookieOptions.sameSite,
    secure: cookieOptions.secure,
    path: cookieOptions.path,
  });
  res.json({ success: true });
});

router.get("/me", (req, res) => {
  if (req.signedCookies?.[COOKIE_NAME] === "1") {
    res.json({ authenticated: true });
    return;
  }
  res.status(401).json({ authenticated: false });
});

export default router;
