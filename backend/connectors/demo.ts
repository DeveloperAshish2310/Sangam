import { eq, inArray } from "drizzle-orm";
import { db, schema } from "../db";
import type { ChannelId } from "../db/schema";
import { emit } from "../events";
import { upsertConversation, upsertMessage } from "../store";
import type { Connector } from "./types";

const REPLIES = ["Got it, thanks! 🙌", "Sounds good — talk soon.", "Perfect, I'll check and get back to you.", "👍"];

/** Fake channel used for demo data: sends succeed instantly and a reply arrives a few seconds later. */
export const demoConnector: Connector = {
  channel: "whatsapp",
  async start() {
    return () => {};
  },
  async send(_ctx, conversation, text, files) {
    setTimeout(async () => {
      // The demo data may have been removed in the meantime.
      const stillThere = await db.query.conversations.findFirst({ where: eq(schema.conversations.id, conversation.id) });
      if (!stillThere) return;
      await upsertMessage(conversation.id, {
        externalId: `demo-in-${Date.now()}`,
        direction: "in",
        senderName: conversation.name,
        text: REPLIES[Math.floor(Math.random() * REPLIES.length)]!,
        sentAt: Date.now(),
      }).catch((error) => console.error("[demo] reply failed", error));
    }, 3000);
    const id = `demo-out-${Date.now()}`;
    // Demo "sends" keep the files locally so attachment previews can be tried without an account.
    return { externalId: id, direction: "out", text, sentAt: Date.now(), attachments: files.map((f, i) => ({ key: String(i), name: f.name, mime: f.mime, size: f.data.length, ref: {}, data: f.data })) };
  },
};

const at = (hhmm: string, daysAgo = 0) => {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(h!, m!, 0, 0);
  return d.getTime();
};

const DEMO: {
  channel: ChannelId;
  name: string;
  subject?: string;
  unread: number;
  starred?: boolean;
  tags: string[];
  messages: { from: "me" | "them"; text: string; at: number }[];
}[] = [
  { channel: "whatsapp", name: "Priya Sharma", unread: 2, tags: ["client", "urgent"], messages: [
    { from: "them", text: "Hey! Did you get a chance to review the proposal?", at: at("14:32") },
    { from: "them", text: "Client wants to close by Friday 🙏", at: at("14:33") } ] },
  { channel: "gmail", name: "Stripe", subject: "Your October payout is on the way", unread: 1, tags: ["finance"], messages: [
    { from: "them", text: "Hi Ashish, a payout of ₹1,24,500 has been initiated and should arrive in 2 business days.", at: at("13:10") } ] },
  { channel: "teams", name: "Design Sync", unread: 4, starred: true, tags: ["work"], messages: [
    { from: "them", text: "Rahul: Pushed the new onboarding screens to Figma.", at: at("12:48") },
    { from: "me", text: "Nice, I'll take a look after lunch.", at: at("12:50") },
    { from: "them", text: "Meera: Can we move standup to 11?", at: at("13:02") } ] },
  { channel: "telegram", name: "Vikram", unread: 0, tags: ["dev"], messages: [
    { from: "them", text: "Sent you the server logs.", at: at("11:20") },
    { from: "me", text: "Got them, thanks!", at: at("11:24") } ] },
  { channel: "mail", name: "Anita (HR)", subject: "Leave approval — Diwali week", unread: 1, tags: ["hr"], messages: [
    { from: "them", text: "Your leave for 9–13 Nov has been approved. Enjoy the festivities!", at: at("10:05") } ] },
  { channel: "whatsapp", name: "Mom", unread: 0, starred: true, tags: ["family"], messages: [
    { from: "them", text: "Call when free beta ❤️", at: at("09:41") } ] },
  { channel: "gmail", name: "Notion", subject: "Weekly digest: 12 updates in your workspace", unread: 0, tags: [], messages: [
    { from: "them", text: "Here's what changed in Acme HQ this week…", at: at("18:00", 1) } ] },
];

export async function loadDemoData() {
  await removeDemoData();
  const accountIds = new Map<ChannelId, number>();
  for (const channel of new Set(DEMO.map((d) => d.channel))) {
    const [row] = await db
      .insert(schema.accounts)
      .values({ channel, externalId: "demo", displayName: "Demo account", status: "demo" })
      .returning({ id: schema.accounts.id });
    accountIds.set(channel, row!.id);
  }
  for (const [i, c] of DEMO.entries()) {
    const id = await upsertConversation(accountIds.get(c.channel)!, { externalId: `demo-${i}`, name: c.name, subject: c.subject ?? null });
    for (const [j, m] of c.messages.entries()) {
      await upsertMessage(id, {
        externalId: `demo-${i}-${j}`,
        direction: m.from === "me" ? "out" : "in",
        senderName: m.from === "me" ? null : c.name,
        text: m.text,
        sentAt: m.at,
        silent: true,
      });
    }
    await db.update(schema.conversations).set({ unread: c.unread, starred: !!c.starred, tags: c.tags }).where(eq(schema.conversations.id, id));
  }
  emit({ type: "reset" });
}

export async function removeDemoData() {
  const demo = await db.select({ id: schema.accounts.id }).from(schema.accounts).where(eq(schema.accounts.status, "demo"));
  if (demo.length) await db.delete(schema.accounts).where(inArray(schema.accounts.id, demo.map((d) => d.id)));
  emit({ type: "reset" });
}
