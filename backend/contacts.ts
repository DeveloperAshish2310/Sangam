import { db, schema } from "./db";

type Conversation = typeof schema.conversations.$inferSelect;
type Contact = typeof schema.contacts.$inferSelect;

export const normalizePhone = (value: string | null | undefined) => (value ?? "").replace(/\D/g, "") || null;
export const normalizeEmail = (value: string | null | undefined) => value?.trim().toLowerCase() || null;

const emailIn = (text: string) => text.match(/[^\s<>"',;]+@[^\s<>"',;]+\.[^\s<>"',;]+/)?.[0]?.toLowerCase() ?? null;

/** The phone number or email address that identifies the other person in a chat, when known. */
export function conversationHandle(c: Conversation): { phone: string | null; email: string | null } {
  const meta = (c.meta ?? {}) as { phone?: string; address?: string; replyTo?: string };
  if (c.channel === "whatsapp") {
    const phone = c.externalId.endsWith("@s.whatsapp.net") ? normalizePhone(c.externalId.split("@")[0]) : null;
    return { phone, email: null };
  }
  if (c.channel === "telegram") return { phone: normalizePhone(meta.phone), email: null };
  if (c.channel === "gmail") return { phone: null, email: normalizeEmail(meta.address) };
  if (c.channel === "mail") return { phone: null, email: meta.replyTo ? emailIn(meta.replyTo) : null };
  return { phone: null, email: null };
}

// Numbers are often saved with or without the country code: the last 10 digits decide.
const samePhone = (a: string, b: string) => a === b || (a.length >= 10 && b.length >= 10 && a.slice(-10) === b.slice(-10));

/** Which saved contact each conversation belongs to: an explicit link first, else phone/email. */
export async function contactsByConversation(convos: Conversation[]) {
  const [all, links] = await Promise.all([db.select().from(schema.contacts), db.select().from(schema.contactLinks)]);
  const byId = new Map(all.map((c) => [c.id, c]));
  const linked = new Map(links.map((l) => [l.conversationId, byId.get(l.contactId)]));
  const out = new Map<number, Contact>();
  for (const convo of convos) {
    const explicit = linked.get(convo.id);
    if (explicit) {
      out.set(convo.id, explicit);
      continue;
    }
    const { phone, email } = conversationHandle(convo);
    const match = all.find((c) => (phone && c.phone && samePhone(phone, c.phone)) || (email && c.email && c.email === email));
    if (match) out.set(convo.id, match);
  }
  return out;
}
