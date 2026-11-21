import { and, eq, isNull } from "drizzle-orm";
import { contactsByConversation, conversationHandle } from "./contacts";
import { db, schema } from "./db";
import { emit } from "./events";
import { SPAM_THRESHOLD, spamScore } from "./spam-score";

/**
 * Local spam filter. Nothing leaves the PC: a few rules plus a keyword score, deliberately
 * cautious — a chat you've replied to, a saved contact or a starred chat is never spam,
 * and "Not spam" teaches it to leave that sender alone.
 */

type Convo = typeof schema.conversations.$inferSelect;

export const SPAM = "spam";
// Settings keys (shared with the page): learned senders and the on/off switch.
const SPAM_SENDERS = "spamSenders";
const NOT_SPAM_SENDERS = "notSpamSenders";


/** The sender this chat is "from", used for learned spam / not-spam lists. */
export function senderKey(convo: Convo) {
  const handle = conversationHandle(convo);
  if (handle.email) return `email:${handle.email.toLowerCase()}`;
  if (handle.phone) return `phone:${handle.phone}`;
  return `chat:${convo.accountId}:${convo.externalId}`;
}

async function readList(key: string) {
  const row = await db.query.settings.findFirst({ where: eq(schema.settings.key, key) });
  return row ? (JSON.parse(row.value) as string[]) : [];
}

async function writeList(key: string, list: string[]) {
  const value = JSON.stringify([...new Set(list)].slice(-5000));
  await db.insert(schema.settings).values({ key, value }).onConflictDoUpdate({ target: schema.settings.key, set: { value } });
}

async function filterEnabled() {
  const row = await db.query.settings.findFirst({ where: eq(schema.settings.key, "spamFilter") });
  return row ? JSON.parse(row.value) !== false : true;
}

/** "Mark as spam" / "Not spam": remembered per sender, so their next chats are sorted the same way. */
export async function learnSpam(convo: Convo, spam: boolean) {
  const key = senderKey(convo);
  const [yes, no] = await Promise.all([readList(SPAM_SENDERS), readList(NOT_SPAM_SENDERS)]);
  await writeList(SPAM_SENDERS, spam ? [...yes, key] : yes.filter((k) => k !== key));
  await writeList(NOT_SPAM_SENDERS, spam ? no.filter((k) => k !== key) : [...no, key]);
}

/** Why a chat can't be spam: you know them, you've written to them, or you marked them safe. */
async function trusted(convo: Convo, notSpam: string[]) {
  // Channels you joined yourself aren't spam, however promotional their posts read.
  if ((convo.meta as { broadcast?: boolean } | null)?.broadcast) return true;
  if (convo.channel === "sangam" || convo.starred || notSpam.includes(senderKey(convo))) return true;
  if ((await contactsByConversation([convo])).has(convo.id)) return true;
  const replied = await db.query.messages.findFirst({
    where: and(eq(schema.messages.conversationId, convo.id), eq(schema.messages.direction, "out")),
    columns: { id: true },
  });
  return !!replied;
}

/** Decides whether an Inbox chat is spam, and moves it to Spam if so. Returns true when moved. */
export async function checkSpam(convoId: number, text: string, opts: { force?: boolean } = {}) {
  if (!opts.force && !(await filterEnabled())) return false;
  const convo = await db.query.conversations.findFirst({ where: eq(schema.conversations.id, convoId) });
  // Only chats in the Inbox: a chat you filed into a folder (or rescued from Spam) stays put.
  if (!convo || convo.folder !== null) return false;
  const [spamSenders, notSpam] = await Promise.all([readList(SPAM_SENDERS), readList(NOT_SPAM_SENDERS)]);
  if (await trusted(convo, notSpam)) return false;
  const learned = spamSenders.includes(senderKey(convo));
  if (!learned && spamScore(text, convo.subject) < SPAM_THRESHOLD) return false;
  await db.update(schema.conversations).set({ folder: SPAM }).where(eq(schema.conversations.id, convoId));
  emit({ type: "conversation", id: convoId });
  return true;
}

/** "Scan Inbox for spam": runs the filter over every Inbox chat's latest incoming message. */
export async function scanInbox() {
  const convos = await db.select().from(schema.conversations).where(and(isNull(schema.conversations.folder), eq(schema.conversations.hidden, false)));
  let moved = 0;
  for (const c of convos) {
    const last = await db.query.messages.findFirst({
      where: and(eq(schema.messages.conversationId, c.id), eq(schema.messages.direction, "in"), eq(schema.messages.hidden, false)),
      orderBy: (m, { desc }) => [desc(m.sentAt)],
      columns: { text: true },
    });
    if (last && (await checkSpam(c.id, last.text, { force: true }))) moved++;
  }
  return { checked: convos.length, moved };
}
