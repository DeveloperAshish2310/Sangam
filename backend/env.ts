import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "..");
const ENV_FILE = path.join(ROOT, ".env");

/** Re-reads .env so newly added keys (e.g. GOOGLE_CLIENT_ID) work without a restart. */
export function reloadEnv() {
  if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
}
reloadEnv();

// The master key encrypts every stored credential (OAuth tokens, Telegram
// session, WhatsApp keys). Generate one on first run and keep it out of git.
if (!process.env.RELAY_MASTER_KEY) {
  const key = randomBytes(32).toString("base64");
  appendFileSync(ENV_FILE, `\n# Encrypts stored account credentials. Never commit or share this.\nRELAY_MASTER_KEY=${key}\n`);
  process.env.RELAY_MASTER_KEY = key;
  console.log("[sangam] Generated RELAY_MASTER_KEY in .env");
}

const masterKey = Buffer.from(process.env.RELAY_MASTER_KEY, "base64");
if (masterKey.length !== 32) throw new Error("RELAY_MASTER_KEY must be 32 bytes, base64-encoded");

export const DATA_DIR = path.join(ROOT, "data");
mkdirSync(DATA_DIR, { recursive: true });

export const env = {
  masterKey,
  port: Number(process.env.RELAY_API_PORT ?? 8787),
  // Loopback only: nothing on the network can reach the API directly.
  host: "127.0.0.1",
  // Where the browser reaches Sangam; OAuth providers redirect back here.
  publicUrl: process.env.RELAY_PUBLIC_URL ?? "http://localhost:8888",
  dbUrl: process.env.RELAY_DB_URL ?? `file:${path.join(DATA_DIR, "relay.db")}`,
  allowedOrigins: (process.env.RELAY_ALLOWED_ORIGINS ?? "http://localhost:8888,http://127.0.0.1:8888").split(","),
};
