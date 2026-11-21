import { and, desc, eq, inArray } from "drizzle-orm";
import webpush, { type PushSubscription } from "web-push";
import { contactsByConversation } from "./contacts";
import { decryptJson, encryptJson } from "./crypto";
import { db, schema } from "./db";
import { env } from "./env";
import { subscribe } from "./events";

/**
 * Web push: the browser keeps a subscription with its push service (Google's for Chrome), so
 * notifications arrive even with no Sangam tab open. Payloads are end-to-end encrypted to the
 * browser; the push service only relays them.
 */

// Internal settings ("_" keys) never reach the page; both are encrypted like account credentials.
const VAPID_KEY = "_vapid";
const SUBS_KEY = "_pushSubscriptions";
// Fewer chats than this get one notification each; more become a single summary.
const SUMMARY_AFTER = 3;
const CHANNEL_NAMES: Record<string, string> = { whatsapp: "WhatsApp", telegram: "Telegram", gmail: "Gmail", mail: "Work Mail", teams: "Teams", sangam: "Sangam" };

async function readSetting<T>(key: string): Promise<T | null> {
  const row = await db.query.settings.findFirst({ where: eq(schema.settings.key, key) });
  return row ? (JSON.parse(row.value) as T) : null;
}

async function writeSetting(key: string, value: unknown) {
  const json = JSON.stringify(value);
  await db.insert(schema.settings).values({ key, value: json }).onConflictDoUpdate({ target: schema.settings.key, set: { value: json } });
}

let vapid: { publicKey: string; privateKey: string } | null = null;
/** This install's push identity, created on first use. */
export async function vapidKeys() {
  if (vapid) return vapid;
  const stored = await readSetting<string>(VAPID_KEY);
  vapid = stored ? decryptJson<{ publicKey: string; privateKey: string }>(stored) : webpush.generateVAPIDKeys();
  if (!stored) await writeSetting(VAPID_KEY, encryptJson(vapid));
  webpush.setVapidDetails(env.publicUrl.startsWith("https:") ? env.publicUrl : "mailto:sangam@localhost", vapid.publicKey, vapid.privateKey);
  return vapid;
}

const readSubs = async () => {
  const stored = await readSetting<string>(SUBS_KEY);
  return stored ? decryptJson<PushSubscription[]>(stored) : [];
};
const writeSubs = (subs: PushSubscription[]) => writeSetting(SUBS_KEY, encryptJson(subs));

export async function addSubscription(sub: PushSubscription) {
  const subs = (await readSubs()).filter((s) => s.endpoint !== sub.endpoint);
  await writeSubs([...subs, sub]);
}

export async function removeSubscription(endpoint: string) {
  await writeSubs((await readSubs()).filter((s) => s.endpoint !== endpoint));
}

type Payload = { title: string; body: string; tag: string; convoId: number | null; silent: boolean };

async function pushAll(payload: Payload) {
  const subs = await readSubs();
  if (!subs.length) return;
  await vapidKeys();
  const gone: string[] = [];
  await Promise.all(
    subs.map((sub) =>
      webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 3600, urgency: "high" }).catch((error: { statusCode?: number; message?: string }) => {
        // 404/410: the browser dropped this subscription (permission revoked, profile reset…).
        if (error.statusCode === 404 || error.statusCode === 410) gone.push(sub.endpoint);
        else console.error("[sangam] push failed:", error.statusCode ?? "", error.message);
      }),
    ),
  );
  if (gone.length) await writeSubs(subs.filter((s) => !gone.includes(s.endpoint)));
}

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};

type NotifySettings = { notifyDesktop?: boolean; notifySound?: boolean; notifyChannels?: string[]; mutedChats?: number[] };

async function announce(convoIds: number[]) {
  const s: NotifySettings = Object.fromEntries(
    (await db.select().from(schema.settings).where(inArray(schema.settings.key, ["notifyDesktop", "notifySound", "notifyChannels", "mutedChats"]))).map((r) => [
      r.key,
      JSON.parse(r.value) as unknown,
    ]),
  );
  if (!s.notifyDesktop) return;
  const convos = (await db.select().from(schema.conversations).where(inArray(schema.conversations.id, convoIds))).filter(
    (c) => c.folder !== "spam" && (c.channel === "sangam" || (s.notifyChannels ?? Object.keys(CHANNEL_NAMES)).includes(c.channel)) && !(s.mutedChats ?? []).includes(c.id),
  );
  if (!convos.length) return;
  const contactOf = await contactsByConversation(convos);
  const nameOf = (c: (typeof convos)[number]) => contactOf.get(c.id)?.name ?? c.name;
  const silent = s.notifySound === false;

  if (convos.length > SUMMARY_AFTER) {
    const names = [...new Set(convos.map(nameOf))];
    const more = names.length > 4 ? ` and ${names.length - 4} more` : "";
    return pushAll({ title: `${convos.length} new messages`, body: clip(`From ${names.slice(0, 4).join(", ")}${more}`, 140), tag: "sangam-summary", convoId: null, silent });
  }
  for (const c of convos) {
    const last = await db.query.messages.findFirst({
      where: and(eq(schema.messages.conversationId, c.id), eq(schema.messages.direction, "in")),
      orderBy: [desc(schema.messages.sentAt), desc(schema.messages.id)],
    });
    if (!last) continue;
    await pushAll({
      title: clip(`${nameOf(c)} · ${CHANNEL_NAMES[c.channel] ?? c.channel}`, 60),
      body: clip([c.subject, last.text].filter(Boolean).join(" — "), 180),
      // Same tag per chat: a newer message replaces the older notification instead of stacking.
      tag: `sangam-${c.id}`,
      convoId: c.id,
      silent,
    });
  }
}

/** Sends a push for new incoming messages; bursts (a sync, a busy group) are announced once. */
export function startPush() {
  const pending = new Set<number>();
  let timer: NodeJS.Timeout | undefined;
  subscribe((event) => {
    // Synced history and your own messages are emitted as "out", so only real new mail lands here.
    if (event.type !== "message" || event.direction !== "in") return;
    pending.add(event.conversationId);
    timer ??= setTimeout(() => {
      const ids = [...pending];
      pending.clear();
      timer = undefined;
      announce(ids).catch((error: unknown) => console.error("[sangam] notification failed:", error));
    }, 1000);
  });
}

/** For "Send test notification": one push straight to every subscribed browser. */
export const pushTest = () =>
  pushAll({ title: "Priya Sharma (Test) · Gmail", body: "Quarterly report, invoices and the final numbers — this came from the Sangam server.", tag: "sangam-test", convoId: null, silent: false });
