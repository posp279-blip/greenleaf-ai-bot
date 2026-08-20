import { pool } from "@workspace/db";
import { logger } from "../lib/logger.js";
import { ensureJarvisSiteIdentity, signJarvisSiteRequest } from "./jarvisSiteIdentity.js";

const SITE_URL = process.env.JARVIS_SITE_URL || "https://greenleaf-podbor.ru";
const SITE_LOOKUP_URL = process.env.JARVIS_SITE_LOOKUP_URL || `${SITE_URL.replace(/\/$/, "")}/api/integrations/jarvis/partner`;
const PROBE_ID = 9876543210123;

type ProbeResult = { ok: boolean; found: boolean; slug?: string };

async function signedLookup(userId: number): Promise<ProbeResult> {
  const body = JSON.stringify({ telegramUserId: String(userId) });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await signJarvisSiteRequest(`${timestamp}.${body}`);
  const response = await fetch(SITE_LOOKUP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Jarvis-Timestamp": timestamp,
      "X-Jarvis-Signature": signature,
    },
    body,
  });
  if (!response.ok) return { ok: false, found: false };
  const payload = await response.json() as { found?: boolean; slug?: string };
  return { ok: true, found: Boolean(payload.found), slug: typeof payload.slug === "string" ? payload.slug : undefined };
}

async function scanExistingProfiles(): Promise<number> {
  const result = await pool.query<{ telegram_user_id: string }>(
    `SELECT telegram_user_id::text
     FROM jarvis_profiles
     WHERE telegram_user_id > 0
     ORDER BY updated_at DESC
     LIMIT 100`,
  );
  let matches = 0;
  for (const row of result.rows) {
    const id = Number(row.telegram_user_id);
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    const lookup = await signedLookup(id);
    if (lookup.ok && lookup.found && lookup.slug) matches += 1;
  }
  return matches;
}

export async function runJarvisV14SelfAudit(): Promise<void> {
  if (process.env.JARVIS_AUDIT_ON_START !== "1") return;
  logger.warn({ audit: "JARVIS_V14_PERSONAL_SITE" }, "V14 AUDIT START");

  const identity = await ensureJarvisSiteIdentity();
  const keyPass = identity.publicKeyB64.length > 40 && identity.privateKeyB64.length > 40;
  logger.warn({ audit: "JARVIS_V14_PERSONAL_SITE", pass: keyPass }, `V14 AUDIT KEY ${keyPass ? "PASS" : "FAIL"}`);

  const probe = await signedLookup(PROBE_ID);
  const signaturePass = probe.ok && !probe.found;
  logger.warn({ audit: "JARVIS_V14_PERSONAL_SITE", pass: signaturePass }, `V14 AUDIT SIGNED LOOKUP ${signaturePass ? "PASS" : "FAIL"}`);

  let existingMatches = 0;
  if (signaturePass) existingMatches = await scanExistingProfiles();
  logger.warn({ audit: "JARVIS_V14_PERSONAL_SITE", existingMatches }, "V14 AUDIT EXISTING LINK MATCHES");

  const pass = keyPass && signaturePass;
  logger.warn({ audit: "JARVIS_V14_PERSONAL_SITE", pass, existingMatches }, `V14 AUDIT SUMMARY ${pass ? "PASS" : "FAIL"}`);
}
