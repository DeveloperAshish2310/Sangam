import { eq } from "drizzle-orm";
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
import { readAttachmentFile, writeAttachmentFile } from "../attachment-files";
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
      await update({ status, statusMessage: message ?? null });
      emit({ type: "account", id: account.id });
    },
    log: (...args) => console.log(`[${account.channel}#${account.id}]`, ...args),
  };
}

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
  await stop?.();
}

export async function startAll() {
  const all = await db.select({ id: schema.accounts.id }).from(schema.accounts);
  await Promise.all(all.map((a) => startAccount(a.id)));
}

export async function stopAll() {
  await Promise.all([...running.keys()].map(stopAccount));
}

export async function sendMessage(conversation: Conversation, text: string, files: OutgoingFile[] = []) {
  const account = await loadAccount(conversation.accountId);
  const connector = connectorFor(account);
  if (!connector) throw new Error(`${account.channel} is not connected yet`);
  const sent = await connector.send(contextFor(account), conversation, text, files);
  const ids = [];
  for (const m of Array.isArray(sent) ? sent : [sent]) ids.push(await upsertMessage(conversation.id, { ...m, direction: "out" }));
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
  const data = await connector.downloadAttachment(contextFor(account), conversation, attachment);
  await writeAttachmentFile(attachment.id, data);
  await db.update(schema.attachments).set({ cached: true }).where(eq(schema.attachments.id, attachment.id));
  return data;
}

export async function markRead(conversation: Conversation) {
  const account = await loadAccount(conversation.accountId);
  const connector = connectorFor(account);
  // Reading in Sangam should also clear it on the provider, but a provider error
  // mustn't block the local state change.
  await connector?.markRead?.(contextFor(account), conversation).catch((error) => console.error(error));
}

/** Presses button [row][col] of a stored message; the page never supplies the button's data itself. */
export async function pressButton(conversation: Conversation, message: Message, row: number, col: number) {
  const button = message.extra?.buttons?.[row]?.[col];
  if (!button) throw new Error("That button no longer exists");
  if (button.kind === "url") return { url: button.url };
  const account = await loadAccount(conversation.accountId);
  const connector = connectorFor(account);
  if (!connector?.pressButton) throw new Error("Buttons aren't supported for this channel");
  return connector.pressButton(contextFor(account), conversation, message.externalId, button);
}

export async function botInfo(conversation: Conversation): Promise<BotInfo> {
  const account = await loadAccount(conversation.accountId);
  const connector = connectorFor(account);
  return connector?.botInfo ? connector.botInfo(contextFor(account), conversation) : { commands: [], keyboard: null };
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
  await connector.deleteMessages(ctx, conversation, externalIds, opts);
}

export async function deleteConversationRemote(conversation: Conversation, opts: DeleteOptions & { keepChat: boolean }) {
  const { ctx, connector, account } = await deleter(conversation);
  if (!connector?.deleteConversation || account.status === "demo") throw new Error("This channel can't delete chats on the service — remove it from Sangam only");
  await connector.deleteConversation(ctx, conversation, opts);
}

export async function compose(accountId: number, input: ComposeInput) {
  const account = await loadAccount(accountId);
  if (account.status !== "connected") throw new Error(`${account.displayName} isn't connected right now`);
  const connector = connectorFor(account);
  if (!connector?.compose) throw new Error("Starting new conversations isn't supported for this channel yet");
  return connector.compose(contextFor(account), input);
}

export async function disconnectAccount(id: number) {
  const account = await loadAccount(id);
  await stopAccount(id);
  await connectorFor(account)?.disconnect?.(contextFor(account)).catch((error) => console.error(error));
  // Cascades to conversations and messages: disconnecting removes the account's data.
  await db.delete(schema.accounts).where(eq(schema.accounts.id, id));
  emit({ type: "reset" });
}
