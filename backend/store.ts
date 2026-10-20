import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { bestText, isStaleHtmlText, stripQuoted } from "./connectors/mime";
import { db, schema } from "./db";
import type { ChannelId, MessageExtra } from "./db/schema";
import { emit } from "./events";
import { writeAttachmentFile } from "./attachment-files";

export type IncomingConversation = {
  externalId: string;
  name: string;
  subject?: string | null;
};

export type IncomingAttachment = {
  key: string;
  name: string;
  mime: string;
  size?: number | null;
  ref: Record<string, unknown>;
  /** Bytes already in hand (files we sent, tiny inline parts) — cached right away. */
  data?: Buffer;
};

/** Records attachments for a stored message (idempotent); returns how many were new. */
async function saveAttachments(messageId: number, list: IncomingAttachment[]) {
  let added = 0;
  for (const a of list) {
    const [inserted] = await db
      .insert(schema.attachments)
      .values({ messageId, key: a.key, name: a.name.slice(0, 255) || "file", mime: a.mime || "application/octet-stream", size: a.size ?? null, ref: a.ref })
      .onConflictDoNothing()
      .returning({ id: schema.attachments.id });
    if (inserted) added++;
    if (!a.data) continue;
    const row = await db.query.attachments.findFirst({ where: and(eq(schema.attachments.messageId, messageId), eq(schema.attachments.key, a.key)) });
    if (row && !row.cached) {
      await writeAttachmentFile(row.id, a.data);
      await db.update(schema.attachments).set({ cached: true }).where(eq(schema.attachments.id, row.id));
    }
  }
  return added;
}

export type IncomingMessage = {
  externalId: string;
  direction: "in" | "out";
  senderName?: string | null;
  text: string;
  html?: string | null;
  sentAt: number;
  status?: (typeof schema.messages.$inferSelect)["status"];
  extra?: MessageExtra | null;
  attachments?: IncomingAttachment[];
  // Backfilled history shouldn't count as unread or trigger notifications.
  silent?: boolean;
};

export async function upsertConversation(accountId: number, conv: IncomingConversation): Promise<number> {
  const account = await db.query.accounts.findFirst({ where: eq(schema.accounts.id, accountId) });
  if (!account) throw new Error(`Unknown account ${accountId}`);
  const [row] = await db
    .insert(schema.conversations)
    .values({ accountId, channel: account.channel, externalId: conv.externalId, name: conv.name, subject: conv.subject ?? null })
    .onConflictDoUpdate({
      target: [schema.conversations.accountId, schema.conversations.externalId],
      set: { name: conv.name, subject: conv.subject ?? null },
    })
    .returning({ id: schema.conversations.id });
  emit({ type: "conversation", id: row!.id });
  return row!.id;
}

/** Inserts a message once (deduplicated by externalId). Returns its id, or null if it already existed. */
export async function upsertMessage(conversationId: number, msg: IncomingMessage): Promise<number | null> {
  const [row] = await db
    .insert(schema.messages)
    .values({
      conversationId,
      externalId: msg.externalId,
      direction: msg.direction,
      senderName: msg.senderName ?? null,
      text: msg.text,
      html: msg.html ?? null,
      sentAt: msg.sentAt,
      status: msg.status ?? "sent",
      extra: msg.extra ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: schema.messages.id });
  if (!row) {
    // Already stored — but a re-sync may know about attachments it didn't before.
    if (msg.attachments?.length) {
      const existing = await db.query.messages.findFirst({
        where: and(eq(schema.messages.conversationId, conversationId), eq(schema.messages.externalId, msg.externalId)),
      });
      if (existing && (await saveAttachments(existing.id, msg.attachments))) emit({ type: "conversation", id: conversationId });
    }
    return null;
  }
  if (msg.attachments?.length) await saveAttachments(row.id, msg.attachments);

  const countsAsUnread = msg.direction === "in" && !msg.silent;
  await db
    .update(schema.conversations)
    .set({
      lastMessageAt: sql`max(${schema.conversations.lastMessageAt}, ${msg.sentAt})`,
      // A new message brings a hidden conversation back, like a real inbox would.
      hidden: false,
      ...(countsAsUnread && { unread: sql`${schema.conversations.unread} + 1` }),
    })
    .where(eq(schema.conversations.id, conversationId));

  emit({ type: "message", conversationId, messageId: row.id, direction: msg.silent ? "out" : msg.direction });
  return row.id;
}

/** Applies an edit made on the provider (e.g. a bot replacing "Searching..." with its answer, or new buttons). */
export async function updateMessage(conversationId: number, externalId: string, update: { text: string; extra?: MessageExtra | null }) {
  const extra = update.extra ?? null;
  const [row] = await db
    .update(schema.messages)
    .set({ text: update.text, extra })
    // Only a real change counts, so re-syncs don't flood the UI with no-op updates.
    .where(
      and(
        eq(schema.messages.conversationId, conversationId),
        eq(schema.messages.externalId, externalId),
        sql`(${schema.messages.text} IS NOT ${update.text} OR coalesce(${schema.messages.extra}, '') IS NOT ${extra ? JSON.stringify(extra) : ""})`,
      ),
    )
    .returning({ id: schema.messages.id });
  if (row) emit({ type: "conversation", id: conversationId });
}

/** Hides messages deleted on the provider, in the given conversations. */
export async function hideMessages(conversationIds: number[], externalIds: string[]) {
  if (!conversationIds.length || !externalIds.length) return;
  const rows = await db
    .update(schema.messages)
    .set({ hidden: true })
    .where(and(inArray(schema.messages.conversationId, conversationIds), inArray(schema.messages.externalId, externalIds)))
    .returning({ conversationId: schema.messages.conversationId });
  for (const id of new Set(rows.map((r) => r.conversationId))) emit({ type: "conversation", id });
}

/**
 * Folds one conversation into another (same person, recorded under two ids — e.g. a WhatsApp
 * hidden "LID" and their phone number). Messages move over, duplicates are dropped, counts merge.
 */
export async function mergeConversation(fromId: number, intoId: number) {
  if (fromId === intoId) return;
  const from = await db.query.conversations.findFirst({ where: eq(schema.conversations.id, fromId) });
  const into = await db.query.conversations.findFirst({ where: eq(schema.conversations.id, intoId) });
  if (!from || !into) return;
  const existing = new Set(
    (await db.select({ id: schema.messages.externalId }).from(schema.messages).where(eq(schema.messages.conversationId, intoId))).map((r) => r.id),
  );
  const moving = await db.select({ id: schema.messages.id, externalId: schema.messages.externalId }).from(schema.messages).where(eq(schema.messages.conversationId, fromId));
  const duplicates = moving.filter((m) => existing.has(m.externalId)).map((m) => m.id);
  const unique = moving.filter((m) => !existing.has(m.externalId)).map((m) => m.id);
  if (duplicates.length) await db.delete(schema.messages).where(inArray(schema.messages.id, duplicates));
  if (unique.length) await db.update(schema.messages).set({ conversationId: intoId }).where(inArray(schema.messages.id, unique));
  await db
    .update(schema.conversations)
    .set({
      // Both copies counted the same unread messages, so take the larger count rather than the sum.
      unread: Math.max(into.unread, from.unread),
      lastMessageAt: Math.max(into.lastMessageAt, from.lastMessageAt),
      starred: into.starred || from.starred,
      tags: [...new Set([...into.tags, ...from.tags])],
      hidden: into.hidden && from.hidden,
    })
    .where(eq(schema.conversations.id, intoId));
  await db.delete(schema.conversations).where(eq(schema.conversations.id, fromId));
  emit({ type: "reset" });
}

/** Adds a channel to the user's visible channels (the picker from setup), if it isn't there. */
export async function showChannel(channel: ChannelId) {
  const row = await db.query.settings.findFirst({ where: eq(schema.settings.key, "channels") });
  if (!row) return; // No saved choice means every channel is shown.
  const channels = JSON.parse(row.value) as ChannelId[];
  if (channels.includes(channel)) return;
  await db.update(schema.settings).set({ value: JSON.stringify([...channels, channel]) }).where(eq(schema.settings.key, "channels"));
}

/** Fixes emails synced before stub detection existed, whose text was just "please enable HTML". */
export async function repairStubTexts() {
  const rows = await db
    .select({ id: schema.messages.id, text: schema.messages.text, html: schema.messages.html })
    .from(schema.messages)
    .where(isNotNull(schema.messages.html));
  for (const row of rows) {
    // Stale text was itself derived from the HTML, so rebuild it from the HTML directly.
    const text = isStaleHtmlText(row.text) ? bestText("", row.html) : bestText(row.text, row.html);
    if (text === row.text) continue;
    await db.update(schema.messages).set({ text: (stripQuoted(text) || text).slice(0, 20_000) }).where(eq(schema.messages.id, row.id));
  }
}

export async function updateMessageStatus(conversationId: number, externalId: string, status: IncomingMessage["status"] & string) {
  await db
    .update(schema.messages)
    .set({ status })
    .where(and(eq(schema.messages.conversationId, conversationId), eq(schema.messages.externalId, externalId)));
  emit({ type: "conversation", id: conversationId });
}
