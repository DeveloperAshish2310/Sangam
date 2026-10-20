import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { ImapFlow, type MailboxObject, type MessageStructureObject } from "imapflow";
import { simpleParser, type AddressObject, type EmailAddress } from "mailparser";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer";
import type Mail from "nodemailer/lib/mailer";
import { db, schema } from "../db";
import { emit } from "../events";
import { upsertConversation, upsertMessage } from "../store";
import { bestText, stripQuoted } from "./mime";
import type { Connector, ConnectorContext } from "./types";

type Server = { host: string; port: number; secure: boolean };
export type MailCredentials = { email: string; name: string; password: string; imap: Server; smtp: Server };
type MailSync = {
  attachmentsSynced?: boolean; uidValidity: string; lastUid: number; sentPath?: string | null; sentUidValidity?: string; sentLastUid?: number };
type ConvoMeta = { replyTo: string; lastMessageId: string; references: string[]; subject: string; sentAt: number };

const BACKFILL = 50;
const BACKFILL_DAYS = 30;
// Enough for the text of almost any email; attachments beyond this are cut off and skipped.
const MAX_SOURCE = 512 * 1024;
const REFRESH_MS = 2 * 60_000;
const RECONNECT_MS = 30_000;
const NOTIFY_WINDOW_MS = 10 * 60_000;
const FLAG_WINDOW = 300;

// TLS is mandatory: either implicit (secure) or an enforced STARTTLS upgrade.
const imapClient = (c: MailCredentials) =>
  new ImapFlow({
    host: c.imap.host,
    port: c.imap.port,
    secure: c.imap.secure,
    ...(!c.imap.secure && { doSTARTTLS: true }),
    auth: { user: c.email, pass: c.password },
    logger: false,
    // Set RELAY_IMAP_DEBUG=1 to print the IMAP conversation (passwords are masked by imapflow).
    ...(process.env.RELAY_IMAP_DEBUG && { logRaw: true, logger: { debug: (o: Record<string, unknown>) => o.src && console.log(`[imap ${o.src}]`, String(o.msg ?? "").slice(0, 200)), info: () => {}, warn: () => {}, error: console.error } }),
    connectionTimeout: 20_000,
  });

const smtpTransport = (c: MailCredentials) =>
  nodemailer.createTransport({
    host: c.smtp.host,
    port: c.smtp.port,
    secure: c.smtp.secure,
    requireTLS: !c.smtp.secure,
    auth: { user: c.email, pass: c.password },
    connectionTimeout: 20_000,
  });

/** Short-lived connection for one-off work, so the long-lived one can keep IDLE-ing on INBOX. */
async function withImap<T>(c: MailCredentials, fn: (client: ImapFlow) => Promise<T>) {
  const client = imapClient(c);
  client.on("error", () => {});
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => {});
  }
}

export function describeMailError(error: unknown, c: MailCredentials) {
  const e = error as { authenticationFailed?: boolean; code?: string; responseCode?: number; message?: string };
  if (e.authenticationFailed || e.code === "EAUTH" || e.responseCode === 535)
    return "Wrong email or password. Most providers need an app password here, not your normal one.";
  if (e.code === "ENOTFOUND") return `Can't find the mail server — check the server names (${c.imap.host} / ${c.smtp.host}).`;
  if (e.code === "ETIMEDOUT" || e.code === "ECONNREFUSED" || e.code === "ESOCKET")
    return "Couldn't reach the mail server — check the server names and ports.";
  return e.message ?? String(error);
}

/** Proves both IMAP and SMTP sign-in work before anything is saved. */
export async function verifyMail(c: MailCredentials) {
  await withImap(c, async () => {});
  await smtpTransport(c).verify();
}

const isAuthError = (error: unknown) => !!(error as { authenticationFailed?: boolean }).authenticationFailed;

const firstAddress = (a: AddressObject | AddressObject[] | undefined): EmailAddress | undefined => (Array.isArray(a) ? a[0] : a)?.value[0];
const addressText = (a: AddressObject | AddressObject[] | undefined) => (Array.isArray(a) ? a.map((x) => x.text).join(", ") : a?.text) ?? "";
const asList = (v: string | string[] | undefined) => (Array.isArray(v) ? v : v ? v.split(/\s+/) : []).filter(Boolean);

async function conversationForMessageIds(accountId: number, ids: string[]) {
  if (!ids.length) return undefined;
  const [row] = await db
    .select({ id: schema.conversations.id, meta: schema.conversations.meta })
    .from(schema.messages)
    .innerJoin(schema.conversations, eq(schema.messages.conversationId, schema.conversations.id))
    .where(and(eq(schema.conversations.accountId, accountId), inArray(schema.messages.externalId, ids)))
    .limit(1);
  return row;
}

type Location = { mailbox: string; uid: number; uidValidity: string };

/** File parts of a message, from its IMAP body structure (no download needed to list them). */
function structureAttachments(node: MessageStructureObject | undefined, out: { key: string; name: string; mime: string; size: number | null }[] = []) {
  if (!node) return out;
  if (node.childNodes?.length) {
    for (const child of node.childNodes) structureAttachments(child, out);
    return out;
  }
  const name = node.dispositionParameters?.filename ?? node.parameters?.name;
  // Images embedded in the HTML (inline + Content-ID) are part of the body, not attachments.
  const embedded = node.disposition === "inline" && !!node.id;
  if ((node.disposition === "attachment" || name) && !embedded) {
    out.push({ key: node.part ?? "1", name: name ?? "attachment", mime: node.type || "application/octet-stream", size: node.size ?? null });
  }
  return out;
}

async function ingest(ctx: ConnectorContext, creds: MailCredentials, source: Buffer, opts: { folder: "inbox" | "sent"; fallbackId: string; silent: boolean; structure?: MessageStructureObject | undefined; at: Location }) {
  const p = await simpleParser(source, { skipImageLinks: true, skipTextToHtml: true });
  const from = firstAddress(p.from);
  const direction = opts.folder === "sent" || from?.address?.toLowerCase() === creds.email ? "out" : "in";
  const messageId = p.messageId ?? opts.fallbackId;
  const references = asList(p.references);
  const inReplyTo = asList(p.inReplyTo)[0];

  // IMAP has no thread ids: join the conversation of any message this one replies to,
  // otherwise start one keyed by the thread's root Message-ID.
  const existing = await conversationForMessageIds(ctx.account.id, [...(inReplyTo ? [inReplyTo] : []), ...references]);
  if (!existing && opts.folder === "sent") return; // Sent mail only joins threads that reached the inbox.

  const counterpart = direction === "in" ? from : firstAddress(p.to);
  const subject = p.subject || "(no subject)";
  const convoId =
    existing?.id ??
    (await upsertConversation(ctx.account.id, {
      externalId: references[0] ?? inReplyTo ?? messageId,
      name: counterpart?.name || counterpart?.address || "Unknown sender",
      subject,
    }));

  const sentAt = (p.date ?? new Date()).getTime();
  const fullText = bestText(p.text ?? "", p.html || null);
  await upsertMessage(convoId, {
    externalId: messageId,
    direction,
    senderName: from?.name || from?.address || null,
    text: (stripQuoted(fullText) || fullText).slice(0, 20_000),
    html: p.html || null,
    sentAt,
    silent: opts.silent || sentAt < Date.now() - NOTIFY_WINDOW_MS,
    attachments: structureAttachments(opts.structure).map((a) => ({ ...a, ref: { ...opts.at, messageId } })),
  });

  // Remember how to reply: to the newest incoming message's Reply-To (or From), in its thread.
  const meta = existing?.meta as ConvoMeta | null | undefined;
  if (direction === "in" && (!meta || sentAt >= meta.sentAt)) {
    const next: ConvoMeta = {
      replyTo: addressText(p.replyTo) || addressText(p.from),
      lastMessageId: messageId,
      references: [...references, messageId].slice(-20),
      subject,
      sentAt,
    };
    await db.update(schema.conversations).set({ meta: next }).where(eq(schema.conversations.id, convoId));
  }
}

type Fetched = { uid: number; source: Buffer; structure?: MessageStructureObject | undefined };

/** Fetches new messages (or the recent backfill) from the open mailbox. */
async function fetchNew(client: ImapFlow, lastUid: number | null) {
  let range: string | number[];
  if (lastUid === null) {
    const since = new Date(Date.now() - BACKFILL_DAYS * 86_400_000);
    const uids = (await client.search({ since }, { uid: true })) || [];
    if (!uids.length) return [];
    range = uids.slice(-BACKFILL);
  } else {
    range = `${lastUid + 1}:*`;
  }
  // Collect first: imapflow can't run other commands while a fetch is streaming.
  const out: Fetched[] = [];
  for await (const m of client.fetch(range, { uid: true, source: { maxLength: MAX_SOURCE }, bodyStructure: true }, { uid: true })) {
    // "n:*" always returns the newest message, even when nothing is newer than n.
    if (m.source && (lastUid === null || m.uid > lastUid)) out.push({ uid: m.uid, source: m.source, structure: m.bodyStructure });
  }
  return out;
}

async function findSentPath(client: ImapFlow) {
  const boxes = await client.list();
  return boxes.find((b) => b.specialUse === "\\Sent")?.path ?? null;
}

const newMessageId = (creds: MailCredentials) => `<${randomUUID()}@${creds.email.split("@")[1]}>`;

/** Sends over SMTP, then files a copy in Sent so other mail apps see it too. */
async function deliver(ctx: ConnectorContext, creds: MailCredentials, mail: Mail.Options) {
  await smtpTransport(creds).sendMail(mail);
  // Gmail and Microsoft file SMTP-sent mail themselves; a second copy would be a duplicate.
  if (/gmail\.com|googlemail\.com|office365\.com|outlook\.com/i.test(creds.smtp.host)) return;
  const sentPath = ctx.getSyncState<MailSync>()?.sentPath;
  if (!sentPath) return;
  const raw = await new MailComposer(mail).compile().build();
  await withImap(creds, (c) => c.append(sentPath, raw, ["\\Seen"])).catch((e) => ctx.log("couldn't save to Sent", e));
}

/**
 * Moves emails (by Message-ID) from Inbox and Sent to the server's Trash folder — what "Delete"
 * does in any mail app. Servers without a Trash folder delete them directly.
 */
async function trashByMessageId(ctx: ConnectorContext, creds: MailCredentials, ids: string[]) {
  let moved = 0;
  let destroyed = 0;
  await withImap(creds, async (c) => {
    const boxes = await c.list();
    let trash = boxes.find((b) => b.specialUse === "\\Trash")?.path;
    const sent = boxes.find((b) => b.specialUse === "\\Sent")?.path;
    // No Trash folder: create one, like mail apps do, rather than deleting permanently.
    if (!trash) trash = (await c.mailboxCreate("Trash").catch(() => null))?.path ?? undefined;
    for (const folder of ["INBOX", ...(sent ? [sent] : [])]) {
      const box = await c.mailboxOpen(folder);
      const uids = new Set<number>();
      for (const id of ids) {
        // Messages without a Message-ID were stored as <uid-VALIDITY-UID@inbox|sent>.
        const fallback = id.match(/^<uid-(\d+)-(\d+)@(inbox|sent)>$/);
        if (fallback) {
          const inThisBox = fallback[3] === (folder === "INBOX" ? "inbox" : "sent") && fallback[1] === String(box.uidValidity);
          if (inThisBox) uids.add(Number(fallback[2]));
          continue;
        }
        for (const uid of (await c.search({ header: { "message-id": id } }, { uid: true })) || []) uids.add(uid);
      }
      if (!uids.size) continue;
      if (trash && trash !== folder) {
        await c.messageMove([...uids], trash, { uid: true });
        moved += uids.size;
      } else {
        // Last resort: the server has no Trash and won't let us create one.
        await c.messageDelete([...uids], { uid: true });
        destroyed += uids.size;
      }
    }
  });
  ctx.log(`deleted on server: ${moved} moved to Trash${destroyed ? `, ${destroyed} permanently (no Trash folder)` : ""}`);
}

export const mailConnector: Connector = {
  async deleteMessages(ctx, _conversation, externalIds) {
    const creds = ctx.getCredentials<MailCredentials>();
    if (!creds) throw new Error("Work Mail is not signed in");
    await trashByMessageId(ctx, creds, externalIds);
  },

  async deleteConversation(ctx, conversation) {
    const creds = ctx.getCredentials<MailCredentials>();
    if (!creds) throw new Error("Work Mail is not signed in");
    const rows = await db.select({ id: schema.messages.externalId }).from(schema.messages).where(eq(schema.messages.conversationId, conversation.id));
    if (rows.length) await trashByMessageId(ctx, creds, rows.map((r) => r.id));
  },

  channel: "mail",

  async start(ctx) {
    const creds = ctx.getCredentials<MailCredentials>();
    if (!creds) throw new Error("Work Mail is not signed in");
    let stopped = false;
    let client: ImapFlow | null = null;
    let refreshTimer: NodeJS.Timeout | undefined;
    let chain = Promise.resolve();
    // One IMAP command sequence at a time per connection.
    const serial = (fn: () => Promise<void>) => {
      chain = chain.then(fn).catch((error) => ctx.log("sync step failed", error));
      return chain;
    };

    const syncInbox = async (c: ImapFlow) => {
      const box = c.mailbox as MailboxObject;
      const state = ctx.getSyncState<MailSync>();
      const fresh = !state || state.uidValidity !== String(box.uidValidity);
      const messages = await fetchNew(c, fresh ? null : state.lastUid);
      // Mail synced before attachment support: re-read the recent window once to list its files.
      const rescan = !fresh && !state.attachmentsSynced ? await fetchNew(c, null) : [];
      for (const m of [...rescan, ...messages]) {
        const at = { mailbox: "INBOX", uid: m.uid, uidValidity: String(box.uidValidity) };
        await ingest(ctx, creds, m.source, { folder: "inbox", fallbackId: `<uid-${box.uidValidity}-${m.uid}@inbox>`, silent: fresh || rescan.includes(m), structure: m.structure, at });
      }
      // After a backfill, older mail outside the window is deliberately skipped (uidNext - 1).
      const lastUid = Math.max(fresh ? box.uidNext - 1 : state.lastUid, ...messages.map((m) => m.uid));
      await ctx.saveSyncState({ ...state, uidValidity: String(box.uidValidity), lastUid, attachmentsSynced: true } satisfies MailSync);
    };

    const syncSent = () =>
      withImap(creds, async (c) => {
        const state = ctx.getSyncState<MailSync>();
        if (!state) return;
        const sentPath = state.sentPath === undefined ? await findSentPath(c) : state.sentPath;
        if (!sentPath) return void ctx.saveSyncState({ ...state, sentPath: null });
        const box = await c.mailboxOpen(sentPath, { readOnly: true });
        const fresh = state.sentUidValidity !== String(box.uidValidity);
        const messages = await fetchNew(c, fresh ? null : (state.sentLastUid ?? null));
        for (const m of messages) {
          const at = { mailbox: sentPath, uid: m.uid, uidValidity: String(box.uidValidity) };
          await ingest(ctx, creds, m.source, { folder: "sent", fallbackId: `<uid-${box.uidValidity}-${m.uid}@sent>`, silent: true, structure: m.structure, at });
        }
        const latest = ctx.getSyncState<MailSync>() ?? state;
        await ctx.saveSyncState({
          ...latest,
          sentPath,
          sentUidValidity: String(box.uidValidity),
          sentLastUid: Math.max(fresh ? box.uidNext - 1 : (state.sentLastUid ?? 0), ...messages.map((m) => m.uid)),
        } satisfies MailSync);
      });

    // The mail server owns read state: recount unread from \Seen flags on recent inbox mail.
    const refreshFlags = async (c: ImapFlow) => {
      const box = c.mailbox as MailboxObject;
      // UID SEARCH + a small header fetch works across servers (some mishandle sequence ranges or ENVELOPE).
      const uids = ((await c.search({ seen: false }, { uid: true })) || []).slice(-FLAG_WINDOW);
      const unseenIds: string[] = [];
      if (uids.length) {
        for await (const m of c.fetch(uids, { uid: true, headers: ["message-id"] }, { uid: true })) {
          const id = m.headers?.toString().match(/<[^>]+>/)?.[0];
          unseenIds.push(id ?? `<uid-${box.uidValidity}-${m.uid}@inbox>`);
        }
      }
      const convos = await db
        .select({ id: schema.conversations.id, unread: schema.conversations.unread })
        .from(schema.conversations)
        .where(eq(schema.conversations.accountId, ctx.account.id));
      const counts = new Map<number, number>();
      if (unseenIds.length) {
        const rows = await db
          .select({ conversationId: schema.messages.conversationId })
          .from(schema.messages)
          .innerJoin(schema.conversations, eq(schema.messages.conversationId, schema.conversations.id))
          .where(and(eq(schema.conversations.accountId, ctx.account.id), eq(schema.messages.direction, "in"), inArray(schema.messages.externalId, unseenIds)));
        for (const r of rows) counts.set(r.conversationId, (counts.get(r.conversationId) ?? 0) + 1);
      }
      for (const { id, unread } of convos) {
        const next = counts.get(id) ?? 0;
        if (next === unread) continue;
        await db.update(schema.conversations).set({ unread: next }).where(eq(schema.conversations.id, id));
        emit({ type: "conversation", id });
      }
    };

    const connectLoop = async () => {
      while (!stopped) {
        try {
          const c = imapClient(creds);
          client = c;
          c.on("error", (error: Error) => ctx.log("connection error", error.message));
          await c.connect();
          if (!ctx.getSyncState<MailSync>()) await ctx.setStatus("connected", "Syncing your inbox…");
          await c.mailboxOpen("INBOX");
          await serial(async () => {
            await syncInbox(c);
            await syncSent();
            await refreshFlags(c);
          });
          await ctx.setStatus("connected");

          // imapflow IDLEs on the open mailbox and emits these as mail arrives or flags change elsewhere.
          c.on("exists", () => void serial(async () => { await syncInbox(c); await refreshFlags(c); }));
          c.on("flags", () => void serial(() => refreshFlags(c)));
          refreshTimer = setInterval(() => void serial(async () => { await syncSent(); await refreshFlags(c); }), REFRESH_MS);

          await new Promise<void>((resolve) => c.once("close", () => resolve()));
          clearInterval(refreshTimer);
        } catch (error) {
          clearInterval(refreshTimer);
          if (isAuthError(error)) {
            await ctx.setStatus("error", "Mail sign-in failed — reconnect Work Mail with a valid app password");
            return;
          }
          ctx.log("disconnected, retrying soon:", describeMailError(error, creds));
        }
        if (!stopped) await new Promise((r) => setTimeout(r, RECONNECT_MS));
      }
    };
    void connectLoop();

    return async () => {
      stopped = true;
      clearInterval(refreshTimer);
      await client?.logout().catch(() => {});
    };
  },

  async send(ctx, conversation, text, files) {
    const creds = ctx.getCredentials<MailCredentials>();
    if (!creds) throw new Error("Work Mail is not signed in");
    const meta = conversation.meta as ConvoMeta | null;
    if (!meta?.replyTo) throw new Error("There's no received email in this conversation to reply to yet");

    const messageId = newMessageId(creds);
    const mail = {
      from: { name: creds.name, address: creds.email },
      to: meta.replyTo,
      subject: /^re:/i.test(meta.subject) ? meta.subject : `Re: ${meta.subject}`,
      inReplyTo: meta.lastMessageId,
      references: meta.references,
      text,
      messageId,
      date: new Date(),
      attachments: files.map((f) => ({ filename: f.name, content: f.data, contentType: f.mime })),
    };
    await deliver(ctx, creds, mail);
    // Cached right away; keys match the IMAP part numbers of the copy in Sent (text is part 1).
    const attachments = files.map((f, i) => ({ key: String(i + 2), name: f.name, mime: f.mime, size: f.data.length, ref: { messageId }, data: f.data }));
    return { externalId: messageId, direction: "out", text, sentAt: Date.now(), silent: true, attachments };
  },

  async downloadAttachment(ctx, _conversation, attachment) {
    const creds = ctx.getCredentials<MailCredentials>();
    if (!creds) throw new Error("Work Mail is not signed in");
    const ref = attachment.ref as Partial<Location> & { messageId?: string };
    return withImap(creds, async (c) => {
      const mailbox = ref.mailbox ?? "INBOX";
      const box = await c.mailboxOpen(mailbox, { readOnly: true });
      let uid = ref.uid;
      // UIDs are only valid within one UIDVALIDITY; otherwise find the message again by Message-ID.
      if (!uid || String(box.uidValidity) !== ref.uidValidity) {
        const found = ref.messageId ? await c.search({ header: { "message-id": ref.messageId } }, { uid: true }) : false;
        uid = found ? found[0] : undefined;
      }
      if (!uid) throw new Error("This email is no longer on the mail server");
      const { content } = await c.download(String(uid), attachment.key, { uid: true });
      if (!content) throw new Error("This attachment is no longer on the mail server");
      const chunks: Buffer[] = [];
      for await (const chunk of content) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks);
    });
  },

  async compose(ctx, { to, subject, text }) {
    const creds = ctx.getCredentials<MailCredentials>();
    if (!creds) throw new Error("Work Mail is not signed in");
    const messageId = newMessageId(creds);
    const finalSubject = subject || "(no subject)";
    const sentAt = Date.now();
    await deliver(ctx, creds, { from: { name: creds.name, address: creds.email }, to, subject: finalSubject, text, messageId, date: new Date(sentAt) });
    // Keyed by our Message-ID, so the recipient's reply (In-Reply-To it) joins this conversation.
    const conversationId = await upsertConversation(ctx.account.id, { externalId: messageId, name: to, subject: finalSubject });
    await upsertMessage(conversationId, { externalId: messageId, direction: "out", text, sentAt, silent: true });
    const meta: ConvoMeta = { replyTo: to, lastMessageId: messageId, references: [messageId], subject: finalSubject, sentAt };
    await db.update(schema.conversations).set({ meta }).where(eq(schema.conversations.id, conversationId));
    return { conversationId };
  },

  async markRead(ctx, conversation) {
    const creds = ctx.getCredentials<MailCredentials>();
    if (!creds) return;
    const incoming = await db
      .select({ id: schema.messages.externalId })
      .from(schema.messages)
      .where(and(eq(schema.messages.conversationId, conversation.id), eq(schema.messages.direction, "in")));
    await withImap(creds, async (c) => {
      await c.mailboxOpen("INBOX");
      const uids: number[] = [];
      for (const { id } of incoming.slice(-20)) {
        const found = await c.search({ header: { "message-id": id } }, { uid: true });
        if (found) uids.push(...found);
      }
      if (uids.length) await c.messageFlagsAdd(uids, ["\\Seen"], { uid: true });
    });
  },
};
