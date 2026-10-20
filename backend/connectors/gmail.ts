import { gmail as gmailApi, type gmail_v1 } from "@googleapis/gmail";
import { and, eq } from "drizzle-orm";
import { OAuth2Client, type Credentials } from "google-auth-library";
import { db, schema } from "../db";
import { emit } from "../events";
import { env, reloadEnv } from "../env";
import { upsertConversation, upsertMessage } from "../store";
import { buildEmail, buildReply, findPartById, gmailAttachments, header, messageBody, parseAddress } from "./mime";
import type { Connector, ConnectorContext, OutgoingFile } from "./types";
import { Readable } from "node:stream";

// gmail.modify covers reading, marking read and sending — and nothing else (no permanent delete).
export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.modify"];

export type GmailCredentials = { tokens: Credentials; email: string };
// attachmentsSynced: emails synced before attachment support get one re-scan to pick them up.
type GmailSync = { historyId: string; attachmentsSynced?: boolean };

const POLL_MS = 30_000;
const BACKFILL_THREADS = 50;
// Mirrors Gmail's main tabs: Promotions, Social and Forums stay out of the unified inbox.
const SKIPPED_LABELS = new Set(["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_FORUMS", "SPAM", "TRASH"]);
const BACKFILL_QUERY = "-category:promotions -category:social -category:forums";
// Older messages appearing later (e.g. a thread moved back to Inbox) shouldn't pop notifications.
const NOTIFY_WINDOW_MS = 10 * 60_000;

export function gmailConfigured() {
  reloadEnv();
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export function oauthClient() {
  return new OAuth2Client({
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri: `${env.publicUrl}/api/connect/gmail/callback`,
  });
}

function clientFor(ctx: ConnectorContext) {
  const creds = ctx.getCredentials<GmailCredentials>();
  if (!creds) throw new Error("Gmail is not signed in");
  const auth = oauthClient();
  auth.setCredentials(creds.tokens);
  // Access tokens refresh hourly; persist them (encrypted) so restarts don't need a new sign-in.
  auth.on("tokens", (tokens) => {
    creds.tokens = { ...creds.tokens, ...tokens };
    void ctx.saveCredentials(creds);
  });
  return { api: gmailApi({ version: "v1", auth }), auth, creds };
}

const isAuthError = (error: unknown) => {
  const e = error as { status?: number; code?: number | string; message?: string };
  return e.status === 401 || e.code === 401 || /invalid_grant|invalid_token/i.test(e.message ?? "");
};

const isSent = (m: gmail_v1.Schema$Message) => !!m.labelIds?.includes("SENT");

async function syncThread(ctx: ConnectorContext, api: gmail_v1.Gmail, threadId: string, opts: { silent: boolean }) {
  const { data: thread } = await api.users.threads.get({ userId: "me", id: threadId, format: "full" });
  const msgs = (thread.messages ?? []).filter((m) => !m.labelIds?.some((l) => l === "SPAM" || l === "TRASH"));
  if (!msgs.length) return;

  const existing = await db.query.conversations.findFirst({
    where: and(eq(schema.conversations.accountId, ctx.account.id), eq(schema.conversations.externalId, threadId)),
  });
  const inInbox = msgs.some((m) => m.labelIds?.includes("INBOX") && !m.labelIds.some((l) => SKIPPED_LABELS.has(l)));
  // Only threads that reached the inbox belong in Sangam; known threads keep syncing (e.g. your replies).
  if (!existing && !inInbox) return;

  const first = msgs[0]!;
  const lastIncoming = [...msgs].reverse().find((m) => !isSent(m));
  const name = lastIncoming ? parseAddress(header(lastIncoming, "From")).name : parseAddress(header(first, "To")).name;
  const convoId = await upsertConversation(ctx.account.id, { externalId: threadId, name, subject: header(first, "Subject") || "(no subject)" });

  const now = Date.now();
  for (const m of msgs) {
    const sentAt = Number(m.internalDate ?? now);
    await upsertMessage(convoId, {
      externalId: m.id!,
      direction: isSent(m) ? "out" : "in",
      senderName: parseAddress(header(m, "From")).name,
      ...messageBody(m),
      attachments: gmailAttachments(m).map((a) => ({ ...a, ref: { gmailId: m.id } })),
      sentAt,
      silent: opts.silent || sentAt < now - NOTIFY_WINDOW_MS,
    });
  }

  // Gmail is the source of truth for read state.
  const unread = msgs.filter((m) => m.labelIds?.includes("UNREAD")).length;
  await db.update(schema.conversations).set({ unread }).where(eq(schema.conversations.id, convoId));
  emit({ type: "conversation", id: convoId });
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(Array.from({ length: limit }, async () => { while (queue.length) await fn(queue.shift()!); }));
}

async function backfill(ctx: ConnectorContext, api: gmail_v1.Gmail) {
  // Take the history checkpoint first so nothing arriving during the backfill is missed.
  const { data: profile } = await api.users.getProfile({ userId: "me" });
  const { data } = await api.users.threads.list({ userId: "me", labelIds: ["INBOX"], q: BACKFILL_QUERY, maxResults: BACKFILL_THREADS });
  // Two at a time keeps a full re-scan under Gmail's per-user rate limit.
  await mapLimit(data.threads ?? [], 2, (t) => syncThread(ctx, api, t.id!, { silent: true }));
  await ctx.saveSyncState({ historyId: profile.historyId!, attachmentsSynced: true } satisfies GmailSync);
}

async function poll(ctx: ConnectorContext, api: gmail_v1.Gmail, state: GmailSync) {
  const threadIds = new Set<string>();
  let historyId = state.historyId;
  let pageToken: string | undefined;
  try {
    do {
      const { data } = await api.users.history.list({
        userId: "me",
        startHistoryId: state.historyId,
        historyTypes: ["messageAdded", "labelAdded", "labelRemoved"],
        ...(pageToken && { pageToken }),
      });
      for (const h of data.history ?? []) {
        for (const item of [...(h.messagesAdded ?? []), ...(h.labelsAdded ?? []), ...(h.labelsRemoved ?? [])]) {
          if (item.message?.threadId) threadIds.add(item.message.threadId);
        }
      }
      historyId = data.historyId ?? historyId;
      pageToken = data.nextPageToken ?? undefined;
    } while (pageToken);
  } catch (error) {
    // A checkpoint older than about a week expires; start over from a fresh backfill.
    if ((error as { code?: number }).code === 404) return backfill(ctx, api);
    throw error;
  }
  for (const id of threadIds) await syncThread(ctx, api, id, { silent: false });
  if (historyId !== state.historyId) await ctx.saveSyncState({ historyId } satisfies GmailSync);
}

/**
 * Sends a raw email through Gmail's upload endpoint, which takes messages up to 35 MB
 * (attachments included), unlike the plain JSON body.
 */
async function sendRaw(api: gmail_v1.Gmail, raw: Buffer, threadId?: string) {
  const { data } = await api.users.messages.send({
    userId: "me",
    requestBody: threadId ? { threadId } : {},
    media: { mimeType: "message/rfc822", body: Readable.from(raw) },
  });
  return data;
}

/** What we just sent, cached locally; keys match the part ids Gmail gives them ("1", "2", …). */
const sentAttachments = (gmailId: string, files: OutgoingFile[]) =>
  files.map((f, i) => ({ key: String(i + 1), name: f.name, mime: f.mime, size: f.data.length, ref: { gmailId }, data: f.data }));

export const gmailConnector: Connector = {
  channel: "gmail",

  async start(ctx) {
    const { api } = clientFor(ctx);
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;

    const run = async () => {
      try {
        const state = ctx.getSyncState<GmailSync>();
        if (!state) {
          await ctx.setStatus("connected", "Syncing your inbox…");
          await backfill(ctx, api);
          await ctx.setStatus("connected");
        } else if (!state.attachmentsSynced) {
          await backfill(ctx, api);
        } else {
          await poll(ctx, api, state);
        }
      } catch (error) {
        if (isAuthError(error)) {
          await ctx.setStatus("error", "Google sign-in expired — reconnect Gmail");
          return;
        }
        ctx.log("sync failed, retrying", error);
      }
      if (!stopped) timer = setTimeout(() => void run(), POLL_MS);
    };
    void run();

    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  },

  async send(ctx, conversation, text, files) {
    const { api, creds } = clientFor(ctx);
    const { data: thread } = await api.users.threads.get({
      userId: "me",
      id: conversation.externalId,
      format: "metadata",
      metadataHeaders: ["From", "Reply-To", "To", "Subject", "Message-ID", "References"],
    });
    const msgs = thread.messages ?? [];
    const last = msgs.at(-1);
    if (!last) throw new Error("This email thread no longer exists in Gmail");
    const lastIncoming = [...msgs].reverse().find((m) => !isSent(m));
    // Replies go to the latest sender (Reply-To wins); a thread you started goes back to its recipients.
    const to = lastIncoming ? header(lastIncoming, "Reply-To") || header(lastIncoming, "From") : header(last, "To");
    const raw = buildReply({
      from: creds.email,
      to,
      subject: header(msgs[0]!, "Subject"),
      inReplyTo: header(last, "Message-ID"),
      references: header(last, "References"),
      text,
      attachments: files,
    });
    const data = await sendRaw(api, raw, conversation.externalId);
    return { externalId: data.id!, direction: "out", text, sentAt: Date.now(), silent: true, attachments: sentAttachments(data.id!, files) };
  },

  async downloadAttachment(ctx, _conversation, attachment) {
    const { api } = clientFor(ctx);
    const gmailId = String(attachment.ref.gmailId);
    // Gmail's attachment ids change on every fetch, so look the part up fresh by its stable part id.
    const { data: msg } = await api.users.messages.get({ userId: "me", id: gmailId, format: "full" });
    const part = findPartById(msg.payload, attachment.key);
    if (!part) throw new Error("This attachment no longer exists in Gmail");
    if (part.body?.data) return Buffer.from(part.body.data, "base64url");
    const { data } = await api.users.messages.attachments.get({ userId: "me", messageId: gmailId, id: part.body!.attachmentId! });
    return Buffer.from(data.data!, "base64url");
  },

  async compose(ctx, { to, subject, text }) {
    const { api, creds } = clientFor(ctx);
    const raw = buildEmail({ from: creds.email, to, subject: subject || "(no subject)", text });
    const data = await sendRaw(api, raw);
    // A conversation is a Gmail thread; the recipient's reply lands in this same thread.
    const conversationId = await upsertConversation(ctx.account.id, { externalId: data.threadId!, name: parseAddress(to).name, subject: subject || "(no subject)" });
    await upsertMessage(conversationId, { externalId: data.id!, direction: "out", text, sentAt: Date.now(), silent: true });
    return { conversationId };
  },

  // Gmail's own "Delete": into Trash, recoverable for 30 days. (gmail.modify can't delete permanently.)
  async deleteMessages(ctx, _conversation, externalIds) {
    const { api } = clientFor(ctx);
    for (const id of externalIds) {
      await api.users.messages.trash({ userId: "me", id }).catch((error) => {
        if ((error as { code?: number }).code !== 404) throw error; // already gone is fine
      });
    }
  },

  async deleteConversation(ctx, conversation) {
    const { api } = clientFor(ctx);
    await api.users.threads.trash({ userId: "me", id: conversation.externalId }).catch((error) => {
      if ((error as { code?: number }).code !== 404) throw error;
    });
  },

  async markRead(ctx, conversation) {
    const { api } = clientFor(ctx);
    await api.users.threads.modify({ userId: "me", id: conversation.externalId, requestBody: { removeLabelIds: ["UNREAD"] } });
  },

  async disconnect(ctx) {
    const creds = ctx.getCredentials<GmailCredentials>();
    const token = creds?.tokens.refresh_token ?? creds?.tokens.access_token;
    // Revoking at Google means the stored token is useless even if a copy survives somewhere.
    if (token) await oauthClient().revokeToken(token);
  },
};
