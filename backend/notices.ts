import { and, eq } from "drizzle-orm";
import { db, schema } from "./db";
import { upsertConversation, upsertMessage } from "./store";

/**
 * The "Sangam" chat: Sangam's own notice board in the Inbox. When an account breaks (sign-in
 * expired, device unlinked…) it posts what happened and how to fix it, and again when it's back.
 * It lives under a built-in "sangam" account that never connects anywhere; replies go nowhere.
 */

const NOTICES_KEY = "_notices"; // last time each notice was posted, so a broken account doesn't post every 30 s
const REPEAT_AFTER_MS = 24 * 60 * 60_000;

const NAMES: Record<string, string> = { gmail: "Gmail", mail: "Work Mail", telegram: "Telegram", whatsapp: "WhatsApp", teams: "Teams" };

async function noticeChat() {
  let account = await db.query.accounts.findFirst({ where: and(eq(schema.accounts.channel, "sangam"), eq(schema.accounts.externalId, "sangam")) });
  if (!account) {
    [account] = await db.insert(schema.accounts).values({ channel: "sangam", externalId: "sangam", displayName: "Sangam", status: "connected" }).returning();
  }
  return upsertConversation(account!.id, { externalId: "notices", name: "Sangam" });
}

async function readPosted() {
  const row = await db.query.settings.findFirst({ where: eq(schema.settings.key, NOTICES_KEY) });
  return row ? (JSON.parse(row.value) as Record<string, number>) : {};
}

async function writePosted(posted: Record<string, number>) {
  const value = JSON.stringify(posted);
  await db.insert(schema.settings).values({ key: NOTICES_KEY, value }).onConflictDoUpdate({ target: schema.settings.key, set: { value } });
}

/** Posts a message in the Sangam chat (at most once a day per key, unless `force`). */
export async function postNotice(key: string, text: string, opts: { force?: boolean } = {}) {
  const posted = await readPosted();
  if (!opts.force && Date.now() - (posted[key] ?? 0) < REPEAT_AFTER_MS) return;
  const convoId = await noticeChat();
  const now = Date.now();
  await upsertMessage(convoId, { externalId: `notice:${key}:${now}`, direction: "in", senderName: "Sangam", text, sentAt: now });
  await writePosted({ ...posted, [key]: now });
}

/** Clears a notice's "already posted" mark, so the same problem is reported again if it comes back. */
async function forget(key: string) {
  const posted = await readPosted();
  if (key in posted) {
    delete posted[key];
    await writePosted(posted);
  }
}

/** What to do about a broken account, in plain words. */
function howToFix(channel: string, message: string) {
  if (channel === "gmail") {
    return [
      "How to fix: open Profile → Gmail → Reconnect, and sign in to Google again.",
      "",
      "Why it happens: Google cancels Sangam's saved sign-in when you change your Google password, remove Sangam's access in your Google account, or (most often) every 7 days while your Google Cloud app is in “Testing” mode.",
      "To stop the weekly sign-outs: Google Cloud Console → APIs & Services → OAuth consent screen → Publish app (“In production”). For personal use it doesn't need Google's review; you'll just see an “unverified app” warning when signing in.",
    ].join("\n");
  }
  if (channel === "whatsapp") {
    return [
      "How to fix: open Profile → WhatsApp → Link, then scan the QR code with WhatsApp on your phone (Settings → Linked devices → Link a device).",
      "",
      "Why it happens: Sangam was removed under Linked devices on your phone, or your phone hadn't been online for about 14 days.",
    ].join("\n");
  }
  if (channel === "telegram") return "How to fix: open Profile → Telegram → Connect, and sign in with your phone number again.\n\nWhy it happens: the session was ended from Telegram (Settings → Devices), or Telegram signed it out.";
  if (channel === "mail") return "How to fix: open Profile → Work Mail → Reconnect with your email and a valid (app) password.\n\nWhy it happens: the password was changed, or the mail server refused the sign-in.";
  return message ? "" : "Open Profile to reconnect it.";
}

type AccountLike = { id: number; channel: string; displayName: string };

/** Called on every account status change: reports breakages and recoveries in the Sangam chat. */
export async function accountStatusChanged(account: AccountLike, before: string, after: string, message: string | null) {
  if (account.channel === "sangam" || after === "demo" || before === "demo") return;
  const name = `${NAMES[account.channel] ?? account.channel} (${account.displayName})`;
  const key = `account:${account.id}`;
  if (after === "error") {
    await postNotice(key, [`⚠️ ${name} stopped syncing`, "", message ?? "It needs to be connected again.", "", howToFix(account.channel, message ?? "")].join("\n").trim());
  } else if (before === "error" && after === "connected") {
    await forget(key);
    await postNotice(`${key}:ok`, `✅ ${name} is working again.`, { force: true });
  }
}

/** On startup: accounts that are already broken get (re)reported, at most once a day. */
export async function reportBrokenAccounts() {
  const broken = await db.select().from(schema.accounts).where(eq(schema.accounts.status, "error"));
  for (const a of broken) await accountStatusChanged(a, "connected", "error", a.statusMessage);
}
