import { asc, eq } from "drizzle-orm";
import { decryptJson, encryptJson } from "../crypto";
import { db, schema } from "../db";
import type { ChannelId } from "../db/schema";
import { emit } from "../events";
import { upsertMessage } from "../store";
import { demoConnector } from "./demo";
import { gmailConnector } from "./gmail";
import { mailConnector } from "./mail";
import { telegramConnector } from "./telegram";
import { whatsappConnector } from "./whatsapp";
import { readAttachmentFile, readThumbFile, writeAttachmentFile, writeThumbFile } from "../attachment-files";
import { dropQueue, queueFor, type JobOptions } from "../jobs";
import { accountStatusChanged, reportBrokenAccounts } from "../notices";
import type { Account, BotInfo, ComposeInput, Connector, ConnectorContext, Conversation, DeleteOptions, OutgoingFile } from "./types";

type Message = typeof schema.messages.$inferSelect;

// Real channel connectors register here as each phase lands.
const connectors: Partial<Record<ChannelId, Connector>> = {
  gmail: gmailConnector,
  mail: mailConnector,
  telegram: telegramConnector,
  whatsapp: whatsappConnector,
};

const running = new Map<number, () => void | Promise<void>>();
const refreshers = new Map<number, () => Promise<void>>();

const connectorFor = (account: Account) => (account.status === "demo" ? demoConnector : connectors[account.channel]);

function contextFor(account: Account): ConnectorContext {
  const update = async (values: Partial<Account>) => {
    await db.update(schema.accounts).set(values).where(eq(schema.accounts.id, account.id));
    Object.assign(account, values);
  };
  return {
    account,
    getCredentials: <T>() => (account.credentials ? decryptJson<T>(account.credentials) : null),
    saveCredentials: (value) => update({ credentials: encryptJson(value) }),
    getSyncState: <T>() => (account.syncState ? (JSON.parse(account.syncState) as T) : null),
    saveSyncState: (value) => update({ syncState: JSON.stringify(value) }),
    setStatus: async (status, message) => {
      const before = account.status;
      await update({ status, statusMessage: message ?? null });
      emit({ type: "account", id: account.id });
      // Breakages and recoveries are reported in the Sangam chat.
      if (before !== status) await accountStatusChanged(account, before, status, message ?? null).catch((error) => console.error("[sangam] notice failed:", error));
    },
    log: (...args) => console.log(`[${account.channel}#${account.id}]`, ...args),
    job: (opts, fn) => queueFor(account).run(opts, fn),
    onRefresh: (fn) => void refreshers.set(account.id, fn),
  };
}

/** Runs one call to the service through the account's queue. */
const job = <T>(account: Account, opts: JobOptions, fn: () => Promise<T>) => queueFor(account).run(opts, fn);

async function loadAccount(id: number) {
  const account = await db.query.accounts.findFirst({ where: eq(schema.accounts.id, id) });
  if (!account) throw new Error(`Unknown account ${id}`);
  return account;
}

export async function startAccount(id: number) {
  await stopAccount(id);
  const account = await loadAccount(id);
  const connector = connectorFor(account);
  if (!connector || account.status === "disconnected") return;
  const ctx = contextFor(account);
  try {
    running.set(id, await connector.start(ctx));
  } catch (error) {
    ctx.log("failed to start", error);
    await ctx.setStatus("error", error instanceof Error ? error.message : String(error));
  }
}

export async function stopAccount(id: number) {
  const stop = running.get(id);
  running.delete(id);
  refreshers.delete(id);
  await stop?.();
}

/** The Refresh button: asks the account to sync now (queued, and shared if a sync is already waiting). */
export async function refreshAccount(id: number) {
  const account = await loadAccount(id);
  if (account.status === "disconnected") return;
  const refresh = refreshers.get(id);
  // No live sync to poke (it failed to start): start it again.
  if (!refresh) return startAccount(id);
  // The connector queues its own sync job (never wrapped here: a job waiting on a job in the same queue could deadlock).
  await refresh();
}

export async function refreshAll() {
  const all = await db.select({ id: schema.accounts.id }).from(schema.accounts);
  await Promise.allSettled(all.map((a) => refreshAccount(a.id)));
}

export async function startAll() {
  const all = await db.select({ id: schema.accounts.id }).from(schema.accounts);
  await Promise.all(all.map((a) => startAccount(a.id)));
  await reportBrokenAccounts().catch((error) => console.error("[sangam] notice failed:", error));
}

export async function stopAll() {
  await Promise.all([...running.keys()].map(stopAccount));
}

export async function sendMessage(conversation: Conversation, text: string, files: OutgoingFile[] = [], html?: string) {
  const account = await loadAccount(conversation.accountId);
  const connector = connectorFor(account);
  if (!connector) throw new Error(`${account.channel} is not connected yet`);
  const sent = await job(account, { name: `send:${conversation.id}:${Date.now()}`, label: files.length ? "Sending files" : "Sending message", priority: "high", repeatable: false, paced: true }, () =>
    connector.send(contextFor(account), conversation, text, files, html ? { html } : undefined),
  );
  const ids = [];
  // The formatted version is kept so the sent bubble shows the formatting too.
  for (const [i, m] of (Array.isArray(sent) ? sent : [sent]).entries())
    ids.push(await upsertMessage(conversation.id, { ...m, direction: "out", ...(html && i === 0 && m.text === text && { html }) }));
  return ids[0] ?? null;
}

/** Bytes of an attachment, downloading (and caching) it from the provider on first use. */
export async function attachmentBytes(attachment: typeof schema.attachments.$inferSelect, conversation: Conversation) {
  if (attachment.cached) {
    const cached = await readAttachmentFile(attachment.id);
    if (cached) return cached;
  }
  const account = await loadAccount(conversation.accountId);
  const connector = connectorFor(account);
  if (!connector?.downloadAttachment) throw new Error("This attachment can't be downloaded");
  // Shared: the chat and the media gallery asking for the same file download it once.
  const data = await job(account, { name: `download:${attachment.id}`, label: `Downloading ${attachment.name}`, priority: "normal", dedupe: true }, () =>
    connector.downloadAttachment!(contextFor(account), conversation, attachment),
  );
  await writeAttachmentFile(attachment.id, data);
  await db.update(schema.attachments).set({ cached: true }).where(eq(schema.attachments.id, attachment.id));
  return data;
}

/** The preview image for a photo or video (cached on disk), or null when the service has none. */
export async function attachmentThumb(attachment: typeof schema.attachments.$inferSelect, conversation: Conversation) {
  const cached = await readThumbFile(attachment.id);
  if (cached) return cached.length ? cached : null;
  const account = await loadAccount(conversation.accountId);
  const connector = connectorFor(account);
  if (!connector?.downloadThumbnail) return null;
  const data = await job(account, { name: `thumb:${attachment.id}`, label: "Loading previews", priority: "high", dedupe: true }, () =>
    connector.downloadThumbnail!(contextFor(account), conversation, attachment),
  );
  await writeThumbFile(attachment.id, data ?? Buffer.alloc(0));
  return data;
}

/** Part of a file straight from the service (video streaming), or null if this service can't do that. */
export async function attachmentRange(attachment: typeof schema.attachments.$inferSelect, conversation: Conversation, start: number, end: number) {
  const account = await loadAccount(conversation.accountId);
  const connector = connectorFor(account);
  if (!connector?.streamAttachment) return null;
  return job(account, { name: `stream:${attachment.id}:${start}`, label: `Playing ${attachment.name}`, priority: "high", dedupe: true }, () =>
    connector.streamAttachment!(contextFor(account), conversation, attachment, start, end),
  );
}

/** A group chat's members (null when the chat isn't a group or the service can't list them). */
export async function groupMembers(conversation: Conversation) {
  const account = await loadAccount(conversation.accountId);
  const connector = connectorFor(account);
  if (!connector?.members || account.status === "demo") return null;
  return job(account, { name: `members:${conversation.id}`, label: "Loading group members", priority: "high", dedupe: true }, () =>
    connector.members!(contextFor(account), conversation),
  );
}

const OLDER_BATCH = 30;

/** Loads the next batch of older messages from the service (scrolling up past what's stored). */
export async function loadOlder(conversation: Conversation) {
  const account = await loadAccount(conversation.accountId);
  const connector = connectorFor(account);
  if (!connector?.loadOlder || account.status === "demo") return { added: 0, done: true };
  const oldest = await db.query.messages.findFirst({
    where: eq(schema.messages.conversationId, conversation.id),
    orderBy: [asc(schema.messages.sentAt), asc(schema.messages.id)],
    columns: { externalId: true },
  });
  return job(account, { name: `older:${conversation.id}`, label: "Loading older messages", priority: "high", dedupe: true }, () =>
    connector.loadOlder!(contextFor(account), conversation, oldest?.externalId ?? null, OLDER_BATCH),
  );
}

export async function markRead(conversation: Conversation) {
  const account = await loadAccount(conversation.accountId);
  const connector = connectorFor(account);
  // Reading in Sangam should also clear it on the provider, but a provider error
  // mustn't block the local state change.
  if (!connector?.markRead) return;
  await job(account, { name: `read:${conversation.id}`, label: "Marking as read", priority: "normal", dedupe: true }, () => connector.markRead!(contextFor(account), conversation)).catch(
    (error) => console.error(error),
  );
}

/** Presses button [row][col] of a stored message; the page never supplies the button's data itself. */
export async function pressButton(conversation: Conversation, message: Message, row: number, col: number) {
  const button = message.extra?.buttons?.[row]?.[col];
  if (!button) throw new Error("That button no longer exists");
  if (button.kind === "url") return { url: button.url };
  const account = await loadAccount(conversation.accountId);
  const connector = connectorFor(account);
  if (!connector?.pressButton) throw new Error("Buttons aren't supported for this channel");
  return job(account, { name: `press:${message.id}`, label: "Pressing button", priority: "high", repeatable: false, paced: true }, () =>
    connector.pressButton!(contextFor(account), conversation, message.externalId, button),
  );
}

export async function botInfo(conversation: Conversation): Promise<BotInfo> {
  const account = await loadAccount(conversation.accountId);
  const connector = connectorFor(account);
  if (!connector?.botInfo) return { commands: [], keyboard: null };
  return job(account, { name: `bot:${conversation.id}`, label: "Loading bot commands", priority: "normal", dedupe: true }, () => connector.botInfo!(contextFor(account), conversation));
}

async function deleter(conversation: Conversation) {
  const account = await loadAccount(conversation.accountId);
  const connector = connectorFor(account);
  return { ctx: contextFor(account), connector, account };
}

/** Deletes on the provider; the caller then hides the rows in Sangam. */
export async function deleteMessagesRemote(conversation: Conversation, externalIds: string[], opts: DeleteOptions) {
  const { ctx, connector, account } = await deleter(conversation);
  if (!connector?.deleteMessages || account.status === "demo") throw new Error("This channel can't delete messages on the service — remove them from Sangam only");
  await job(account, { name: `delete:${conversation.id}:${Date.now()}`, label: "Deleting messages", priority: "high" }, () => connector.deleteMessages!(ctx, conversation, externalIds, opts));
}

export async function deleteConversationRemote(conversation: Conversation, opts: DeleteOptions & { keepChat: boolean }) {
  const { ctx, connector, account } = await deleter(conversation);
  if (!connector?.deleteConversation || account.status === "demo") throw new Error("This channel can't delete chats on the service — remove it from Sangam only");
  await job(account, { name: `delete-chat:${conversation.id}`, label: opts.keepChat ? "Clearing chat" : "Deleting chat", priority: "high", dedupe: true }, () =>
    connector.deleteConversation!(ctx, conversation, opts),
  );
}

export async function compose(accountId: number, input: ComposeInput) {
  const account = await loadAccount(accountId);
  if (account.status !== "connected") throw new Error(`${account.displayName} isn't connected right now`);
  const connector = connectorFor(account);
  if (!connector?.compose) throw new Error("Starting new conversations isn't supported for this channel yet");
  return job(account, { name: `compose:${Date.now()}`, label: "Sending new message", priority: "high", repeatable: false, paced: true }, () => connector.compose!(contextFor(account), input));
}

export async function disconnectAccount(id: number) {
  const account = await loadAccount(id);
  await stopAccount(id);
  dropQueue(id);
  await connectorFor(account)?.disconnect?.(contextFor(account)).catch((error) => console.error(error));
  // Cascades to conversations and messages: disconnecting removes the account's data.
  await db.delete(schema.accounts).where(eq(schema.accounts.id, id));
  emit({ type: "reset" });
}
