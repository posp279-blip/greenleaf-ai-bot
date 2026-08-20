import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { pool } from "@workspace/db";

const PRIVATE_KEY_SETTING = "jarvis_site_signing_private_key_b64";
const PUBLIC_KEY_SETTING = "jarvis_site_signing_public_key_b64";
const KEY_LOCK_ID = 91320260820;

type Identity = {
  privateKeyB64: string;
  publicKeyB64: string;
};

let cachedIdentity: Identity | null = null;

async function readIdentity(): Promise<Identity | null> {
  const result = await pool.query<{ key: string; value: string }>(
    `SELECT key, value FROM app_settings WHERE key = ANY($1::text[])`,
    [[PRIVATE_KEY_SETTING, PUBLIC_KEY_SETTING]],
  );
  const values = new Map(result.rows.map((row) => [row.key, row.value]));
  const privateKeyB64 = values.get(PRIVATE_KEY_SETTING) || "";
  const publicKeyB64 = values.get(PUBLIC_KEY_SETTING) || "";
  if (!privateKeyB64 || !publicKeyB64) return null;
  return { privateKeyB64, publicKeyB64 };
}

async function createIdentity(): Promise<Identity> {
  const cx = await pool.connect();
  try {
    await cx.query("BEGIN");
    await cx.query("SELECT pg_advisory_xact_lock($1::bigint)", [KEY_LOCK_ID]);

    const existing = await cx.query<{ key: string; value: string }>(
      `SELECT key, value FROM app_settings WHERE key = ANY($1::text[])`,
      [[PRIVATE_KEY_SETTING, PUBLIC_KEY_SETTING]],
    );
    const values = new Map(existing.rows.map((row) => [row.key, row.value]));
    const currentPrivate = values.get(PRIVATE_KEY_SETTING) || "";
    const currentPublic = values.get(PUBLIC_KEY_SETTING) || "";
    if (currentPrivate && currentPublic) {
      await cx.query("COMMIT");
      return { privateKeyB64: currentPrivate, publicKeyB64: currentPublic };
    }

    const generated = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "der" },
      privateKeyEncoding: { type: "pkcs8", format: "der" },
    });
    const privateKeyB64 = Buffer.from(generated.privateKey).toString("base64");
    const publicKeyB64 = Buffer.from(generated.publicKey).toString("base64");

    await cx.query(
      `INSERT INTO app_settings(key, value, updated_at)
       VALUES ($1, $2, NOW()), ($3, $4, NOW())
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`,
      [PRIVATE_KEY_SETTING, privateKeyB64, PUBLIC_KEY_SETTING, publicKeyB64],
    );
    await cx.query("COMMIT");
    return { privateKeyB64, publicKeyB64 };
  } catch (err) {
    await cx.query("ROLLBACK");
    throw err;
  } finally {
    cx.release();
  }
}

export async function ensureJarvisSiteIdentity(): Promise<Identity> {
  if (cachedIdentity) return cachedIdentity;
  cachedIdentity = (await readIdentity()) || (await createIdentity());
  return cachedIdentity;
}

export async function getJarvisSitePublicKeyB64(): Promise<string> {
  return (await ensureJarvisSiteIdentity()).publicKeyB64;
}

export async function signJarvisSiteRequest(payload: string): Promise<string> {
  const identity = await ensureJarvisSiteIdentity();
  const privateKey = createPrivateKey({
    key: Buffer.from(identity.privateKeyB64, "base64"),
    format: "der",
    type: "pkcs8",
  });
  return sign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64");
}
