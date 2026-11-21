import { and, eq } from "drizzle-orm";
import { Api, TelegramClient, utils } from "telegram";
import { NewMessage, type NewMessageEvent } from "telegram/events";
import { EditedMessage, type EditedMessageEvent } from "telegram/events/EditedMessage";
import { Raw } from "telegram/events/Raw";
import { Logger, LogLevel } from "telegram/extensions/Logger";
import { returnBigInt } from "telegram/Helpers";
import { StringSession } from "telegram/sessions";
import { CustomFile } from "telegram/client/uploads";
import { clearAvatar, saveAvatar } from "../avatars";
import { db, schema } from "../db";
import { emit } from "../events";
import { reloadEnv } from "../env";
import type { MessageButton, MessageExtra } from "../db/schema";
import { hideMessages, updateMessage, upsertConversation, upsertMessage } from "../store";
import type { BotCommand, Connector, ConnectorContext, GroupMember } from "./types";

// The session string is a full login to your Telegram account — it's only ever stored encrypted.
export type TelegramCredentials = { session: string };
type ConvoMeta = {
  muted?: boolean;
  photoId?: string | null;
  // The custom keyboard a bot asked to show instead of the normal one (null = hidden).
  keyboard?: string[][] | null;
  commands?: BotCommand[];
  commandsAt?: number;
  phone?: string;
  /** A broadcast channel (a feed): posts come from the channel, not from people. */
  broadcast?: boolean;
  /** You can't post here (a channel you don't admin): Sangam hides the composer. */
  readOnly?: boolean;
  /** Whether the chat was in Telegram's Archived folder at the last sync. */
  tgArchived?: boolean;
};

const COMMANDS_TTL_MS = 24 * 3600_000;

async function patchMeta(convoId: number, patch: Partial<ConvoMeta>) {
  const convo = await db.query.conversations.findFirst({ where: eq(schema.conversations.id, convoId) });
  const meta = { ...((convo?.meta ?? {}) as ConvoMeta), ...patch };
  await db.update(schema.conversations).set({ meta }).where(eq(schema.conversations.id, convoId));
  return meta;
}

// Chats whose recent history is re-read on every sync; older ones only get their latest message.
const BACKFILL_DIALOGS = 40;
const BACKFILL_MESSAGES = 20;

export function telegramConfig() {
  reloadEnv();
  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = process.env.TELEGRAM_API_HASH ?? "";
  return apiId && apiHash ? { apiId, apiHash } : null;
}

export function telegramClient(session = "") {
  const config = telegramConfig();
  if (!config) throw new Error("Add TELEGRAM_API_ID and TELEGRAM_API_HASH to .env");
  return new TelegramClient(new StringSession(session), config.apiId, config.apiHash, {
    connectionRetries: 5,
    autoReconnect: true,
    // Shown under Telegram → Settings → Devices, so you can recognise (and revoke) Sangam.
    deviceModel: "Sangam (this PC)",
    appVersion: "1.0",
    systemVersion: "Windows",
    baseLogger: new Logger(LogLevel.ERROR),
  });
}

type Entity = Api.User | Api.Chat | Api.Channel;

export function entityName(entity: Entity | undefined | null) {
  if (!entity) return "Unknown";
  if ("title" in entity && entity.title) return entity.title;
  const user = entity as Api.User;
  return [user.firstName, user.lastName].filter(Boolean).join(" ") || (user.username ? `@${user.username}` : user.phone ? `+${user.phone}` : "Unknown");
}

// Broadcast channels are feeds: posts come from the channel itself, and only admins can post.
const isBroadcast = (entity: Entity | undefined) => entity instanceof Api.Channel && !entity.megagroup;
const canPost = (entity: Api.Channel) => !!(entity.creator || entity.adminRights?.postMessages);
const channelMeta = (entity: Entity): Partial<ConvoMeta> =>
  isBroadcast(entity) ? { broadcast: true, readOnly: !canPost(entity as Api.Channel) } : {};

const mediaLabelFor = (mime: string, name: string) =>
  mime.startsWith("image/") ? "📷 Photo" : mime.startsWith("video/") ? "🎬 Video" : mime.startsWith("audio/") ? "🎵 Audio" : `📎 ${name}`;

function messageText(m: Api.Message) {
  if (m.message) return m.message;
  const media = m.media;
  if (!media) return m.action ? "[Service message]" : "";
  if (media instanceof Api.MessageMediaPhoto) return "📷 Photo";
  if (media instanceof Api.MessageMediaDocument) {
    const doc = media.document instanceof Api.Document ? media.document : undefined;
    const attrs = doc?.attributes ?? [];
    if (attrs.some((a) => a instanceof Api.DocumentAttributeSticker)) return "Sticker";
    if (attrs.some((a) => a instanceof Api.DocumentAttributeAudio && a.voice)) return "🎤 Voice message";
    if (attrs.some((a) => a instanceof Api.DocumentAttributeVideo)) return "🎬 Video";
    const file = attrs.find((a): a is Api.DocumentAttributeFilename => a instanceof Api.DocumentAttributeFilename);
    return `📎 ${file?.fileName ?? "File"}`;
  }
  if (media instanceof Api.MessageMediaGeo || media instanceof Api.MessageMediaGeoLive) return "📍 Location";
  if (media instanceof Api.MessageMediaContact) return "👤 Contact";
  if (media instanceof Api.MessageMediaPoll) return `📊 Poll: ${media.poll.question.text}`;
  return "[Media]";
}

async function senderName(m: Api.Message, chat: Entity | undefined) {
  if (m.out) return null;
  // In a private chat the sender is the chat itself; in groups, look the member up.
  if (chat instanceof Api.User) return entityName(chat);
  // Channel posts are signed by the channel (or by an admin, when signatures are on).
  if (isBroadcast(chat)) return m.postAuthor ?? entityName(chat);
  const sender = (await m.getSender().catch(() => undefined)) as Entity | undefined;
  return sender ? entityName(sender) : null;
}

async function findConversation(accountId: number, peerId: string) {
  return db.query.conversations.findFirst({
    where: and(eq(schema.conversations.accountId, accountId), eq(schema.conversations.externalId, peerId)),
  });
}

async function displayText(m: Api.Message, chat: Entity | undefined) {
  const text = messageText(m);
  const sender = await senderName(m, chat);
  // Group messages read better with the author in front, like the demo data does.
  return { sender, text: !text || chat instanceof Api.User || isBroadcast(chat) || m.out ? text : `${sender ?? "Someone"}: ${text}` };
}

/** A bot's inline buttons under its message. Callback data stays server-side for pressButton. */
function inlineButtons(m: Api.Message): MessageExtra | null {
  const markup = m.replyMarkup;
  if (!(markup instanceof Api.ReplyInlineMarkup)) return null;
  const buttons = markup.rows.map((row) =>
    row.buttons.map((b): MessageButton => {
      if (b instanceof Api.KeyboardButtonCallback) return { text: b.text, kind: "callback", data: Buffer.from(b.data).toString("base64") };
      if (b instanceof Api.KeyboardButtonUrl) return { text: b.text, kind: "url", url: b.url };
      // Login, payment, game, phone-request buttons etc. need the official app.
      return { text: b.text, kind: "unsupported" };
    }),
  );
  return buttons.length ? { buttons } : null;
}

/** Tracks the custom reply keyboard a bot shows or hides. */
async function trackKeyboard(convoId: number, m: Api.Message) {
  if (m.out) return;
  const markup = m.replyMarkup;
  if (markup instanceof Api.ReplyKeyboardMarkup) {
    await patchMeta(convoId, { keyboard: markup.rows.map((row) => row.buttons.map((b) => b.text)) });
    emit({ type: "conversation", id: convoId });
  } else if (markup instanceof Api.ReplyKeyboardHide) {
    await patchMeta(convoId, { keyboard: null });
    emit({ type: "conversation", id: convoId });
  }
}

/** The downloadable file in a message (photo, video, voice, document, sticker), if any. */
function mediaAttachment(m: Api.Message) {
  const ref = { peer: utils.getPeerId(m.peerId), msgId: m.id };
  const media = m.media;
  if (media instanceof Api.MessageMediaPhoto && media.photo instanceof Api.Photo) {
    return { key: "media", name: `photo-${m.id}.jpg`, mime: "image/jpeg", size: null, ref };
  }
  if (media instanceof Api.MessageMediaDocument && media.document instanceof Api.Document) {
    const doc = media.document;
    const fileName = doc.attributes.find((a): a is Api.DocumentAttributeFilename => a instanceof Api.DocumentAttributeFilename)?.fileName;
    const voice = doc.attributes.some((a) => a instanceof Api.DocumentAttributeAudio && a.voice);
    const ext = (doc.mimeType.split("/")[1] ?? "bin").replace(/[^a-z0-9]/gi, "").slice(0, 8) || "bin";
    const name = fileName ?? (voice ? `voice-${m.id}.ogg` : `file-${m.id}.${ext}`);
    const video = doc.attributes.find((a): a is Api.DocumentAttributeVideo => a instanceof Api.DocumentAttributeVideo);
    return {
      key: "media", name, mime: doc.mimeType || "application/octet-stream", size: Number(String(doc.size)),
      ref: { ...ref, ...(video && { duration: Math.round(video.duration), w: video.w, h: video.h }) },
    };
  }
  return null;
}

async function storeMessage(convoId: number, m: Api.Message, chat: Entity | undefined, silent: boolean, history = false) {
  const { sender, text } = await displayText(m, chat);
  if (!text) return;
  const attachment = mediaAttachment(m);
  // Without a caption the text is just a label like "📷 Photo"; the chat shows the file instead.
  const extra = attachment && !m.message ? { ...inlineButtons(m), mediaLabel: true } : inlineButtons(m);
  const inserted = await upsertMessage(convoId, {
    externalId: String(m.id),
    direction: m.out ? "out" : "in",
    senderName: sender,
    text,
    sentAt: m.date * 1000,
    silent,
    extra,
    ...(attachment && { attachments: [attachment] }),
  });
  // Already stored: pick up any edit made while Sangam wasn't running.
  if (inserted === null) await updateMessage(convoId, String(m.id), { text, extra });
  // Older history mustn't replace the keyboard a bot shows right now.
  if (!history) await trackKeyboard(convoId, m);
}

const photoIdOf = (entity: Entity) => {
  const photo = "photo" in entity ? entity.photo : undefined;
  return photo instanceof Api.UserProfilePhoto || photo instanceof Api.ChatPhoto ? photo.photoId.toString() : null;
};

/** Downloads the chat's small profile photo, only when it changed since last time. */
async function syncPhoto(client: TelegramClient, convoId: number, entity: Entity) {
  const convo = await db.query.conversations.findFirst({ where: eq(schema.conversations.id, convoId) });
  const meta = (convo?.meta ?? {}) as ConvoMeta;
  const photoId = photoIdOf(entity);
  if (photoId === (meta.photoId ?? null) && (photoId === null || convo?.avatar)) return;
  if (photoId) {
    const image = await client.downloadProfilePhoto(entity, { isBig: false }).catch(() => undefined);
    // Some people hide their photo from non-contacts; that just leaves the initials.
    if (Buffer.isBuffer(image) && image.length) await saveAvatar(convoId, image);
  } else {
    await clearAvatar(convoId);
  }
  await patchMeta(convoId, { photoId });
}

async function backfill(ctx: ConnectorContext, client: TelegramClient) {
  // Everything the Telegram app lists: chats, groups and channels, including the Archived folder
  // (no folder filter = both).
  const dialogs = (await client.getDialogs({})).filter((d) => d.entity && d.id);
  for (const [i, d] of dialogs.entries()) {
    const entity = d.entity as Entity;
    const peerId = d.id!.toString();
    const muted = (d.dialog.notifySettings.muteUntil ?? 0) * 1000 > Date.now();
    const existing = await findConversation(ctx.account.id, peerId);
    const convoId = await upsertConversation(ctx.account.id, { externalId: peerId, name: entityName(entity) });
    // Telegram shares a phone only for your contacts; when it does, saved contacts can match it.
    if (entity instanceof Api.User && entity.phone) await patchMeta(convoId, { phone: entity.phone });
    if (!existing || i < BACKFILL_DIALOGS) {
      // New chats and the most recent ones: their recent history.
      const messages = await client.getMessages(entity, { limit: BACKFILL_MESSAGES });
      for (const m of [...messages].reverse()) await storeMessage(convoId, m, entity, true);
    } else if (d.message) {
      // Older chats already synced: just their latest message, which came with the chat list.
      await storeMessage(convoId, d.message, entity, true);
    }
    // Telegram owns read state, mute and archive. Archive is copied only when it changes in
    // Telegram, so archiving/unarchiving a chat in Sangam isn't undone by the next sync.
    const prevArchived = ((existing?.meta ?? {}) as ConvoMeta).tgArchived;
    const archiveChanged = existing ? (prevArchived ?? false) !== d.archived : true;
    await patchMeta(convoId, { muted, tgArchived: d.archived, ...channelMeta(entity) });
    await db
      .update(schema.conversations)
      .set({ unread: d.unreadCount, ...(archiveChanged && { archived: d.archived }) })
      .where(eq(schema.conversations.id, convoId));
    emit({ type: "conversation", id: convoId });
  }
  const channels = dialogs.filter((d) => isBroadcast(d.entity as Entity)).length;
  const groups = dialogs.filter((d) => !(d.entity instanceof Api.User)).length - channels;
  ctx.log(`synced ${dialogs.length} chats (${groups} groups, ${channels} channels, ${dialogs.filter((d) => d.archived).length} archived)`);
  // Photos last, so chats appear first and pictures fill in after.
  for (const d of dialogs) {
    const convo = await findConversation(ctx.account.id, d.id!.toString());
    if (convo) await syncPhoto(client, convo.id, d.entity as Entity).catch((err) => ctx.log("photo failed", err));
  }
}

async function onNewMessage(ctx: ConnectorContext, event: NewMessageEvent) {
  const m = event.message;
  const chat = (await m.getChat().catch(() => undefined)) as Entity | undefined;
  if (!chat) return;
  const peerId = utils.getPeerId(m.peerId);
  const existing = await findConversation(ctx.account.id, peerId);
  const convoId = existing?.id ?? (await upsertConversation(ctx.account.id, { externalId: peerId, name: entityName(chat) }));
  if (!existing && chat instanceof Api.User && chat.phone) await patchMeta(convoId, { phone: chat.phone });
  if (!existing && isBroadcast(chat)) await patchMeta(convoId, channelMeta(chat));
  const muted = !!(existing?.meta as ConvoMeta | null)?.muted;
  await storeMessage(convoId, m, chat, muted);
  if (!existing) await syncPhoto(event.client!, convoId, chat).catch((err) => ctx.log("photo failed", err));
}

async function onEdited(ctx: ConnectorContext, event: EditedMessageEvent) {
  const m = event.message;
  const convo = await findConversation(ctx.account.id, utils.getPeerId(m.peerId));
  if (!convo) return;
  const chat = (await m.getChat().catch(() => undefined)) as Entity | undefined;
  const { text } = await displayText(m, chat);
  // Bots often edit both the text and the buttons (e.g. paging through results).
  if (text) await updateMessage(convo.id, String(m.id), { text, extra: inlineButtons(m) });
}

async function onDeleted(ctx: ConnectorContext, update: Api.TypeUpdate) {
  if (update instanceof Api.UpdateDeleteChannelMessages) {
    const convo = await findConversation(ctx.account.id, utils.getPeerId(new Api.PeerChannel({ channelId: update.channelId })));
    if (convo) await hideMessages([convo.id], update.messages.map(String));
  } else if (update instanceof Api.UpdateDeleteMessages) {
    // Private chats and small groups share one id sequence per account, and Telegram
    // doesn't say which chat they were in — so match across those conversations.
    const convos = await db
      .select({ id: schema.conversations.id, externalId: schema.conversations.externalId })
      .from(schema.conversations)
      .where(eq(schema.conversations.accountId, ctx.account.id));
    await hideMessages(convos.filter((c) => !c.externalId.startsWith("-100")).map((c) => c.id), update.messages.map(String));
  }
}

async function onReadElsewhere(ctx: ConnectorContext, update: Api.TypeUpdate) {
  // Reading a chat on your phone clears it in Sangam too.
  let peerId: string | undefined;
  let stillUnread = 0;
  if (update instanceof Api.UpdateReadHistoryInbox) {
    peerId = utils.getPeerId(update.peer);
    stillUnread = update.stillUnreadCount;
  } else if (update instanceof Api.UpdateReadChannelInbox) {
    peerId = utils.getPeerId(new Api.PeerChannel({ channelId: update.channelId }));
    stillUnread = update.stillUnreadCount;
  }
  if (!peerId) return;
  const convo = await findConversation(ctx.account.id, peerId);
  if (!convo || convo.unread === stillUnread) return;
  await db.update(schema.conversations).set({ unread: stillUnread }).where(eq(schema.conversations.id, convo.id));
  emit({ type: "conversation", id: convo.id });
}

// Peer ids are stored as marked strings ("-100…" for groups); GramJS treats plain strings as
// usernames, so hand it the number to resolve from its entity cache.
const peer = (externalId: string) => returnBigInt(externalId);

// A message's media object, kept a while so streaming a video doesn't re-fetch the message for
// every chunk. Telegram's file references expire, so a failed read retries with a fresh one.
const mediaCache = new Map<string, { media: Api.TypeMessageMedia; at: number }>();
const MEDIA_TTL_MS = 20 * 60_000;

async function messageMedia(client: TelegramClient, peerId: string, msgId: number, fresh = false) {
  const key = `${peerId}:${msgId}`;
  const hit = mediaCache.get(key);
  if (!fresh && hit && Date.now() - hit.at < MEDIA_TTL_MS) return hit.media;
  const [msg] = await client.getMessages(peer(peerId), { ids: msgId });
  if (!msg?.media) throw new Error("This file is no longer available in Telegram");
  mediaCache.delete(key);
  mediaCache.set(key, { media: msg.media, at: Date.now() });
  if (mediaCache.size > 300) mediaCache.delete(mediaCache.keys().next().value!);
  return msg.media;
}

const isExpiredReference = (error: unknown) => /FILE_REFERENCE_/.test(String((error as Error)?.message ?? error));

/** The preview to show: ~800px for photos, the largest thumbnail for videos and files. */
function previewSize(media: Api.TypeMessageMedia) {
  const sizes =
    media instanceof Api.MessageMediaPhoto && media.photo instanceof Api.Photo
      ? media.photo.sizes
      : media instanceof Api.MessageMediaDocument && media.document instanceof Api.Document
        ? (media.document.thumbs ?? [])
        : [];
  const plain = sizes.filter((s): s is Api.PhotoSize => s instanceof Api.PhotoSize).sort((a, b) => a.w - b.w);
  return plain.filter((s) => s.w <= 1000).pop() ?? plain[0];
}

const STREAM_CHUNK = 512 * 1024;
// Big groups: list this many members (owner and admins always come first).
const MEMBER_LIMIT = 500;

const roleOf = (p: unknown): GroupMember["role"] =>
  p instanceof Api.ChannelParticipantCreator || p instanceof Api.ChatParticipantCreator
    ? "owner"
    : p instanceof Api.ChannelParticipantAdmin || p instanceof Api.ChatParticipantAdmin
      ? "admin"
      : "member";

const clients = new Map<number, TelegramClient>();
// Per account: "reconnect now if down" (from the watchdog in start()).
const reconnectors = new Map<number, () => Promise<void>>();

async function clientFor(ctx: ConnectorContext) {
  if (!clients.get(ctx.account.id)?.connected) {
    // Don't fail straight away: try to bring the connection back first (bounded, so a click never hangs).
    const reconnect = reconnectors.get(ctx.account.id);
    if (reconnect) await Promise.race([reconnect(), new Promise((r) => setTimeout(r, 15_000))]);
  }
  const running = clients.get(ctx.account.id);
  if (running?.connected) return running;
  throw new Error("Telegram is offline right now — Sangam keeps reconnecting automatically; try again in a minute");
}

const isSessionRevoked = (error: unknown) => /AUTH_KEY_UNREGISTERED|SESSION_REVOKED|USER_DEACTIVATED|AUTH_KEY_DUPLICATED/.test(String((error as Error)?.message ?? error));

const toCommands = (list: Api.BotCommand[] | undefined) => (list ?? []).map((c) => ({ command: c.command, description: c.description }));

/** Commands of the bot in a private chat, or of every bot in a group. */
async function fetchCommands(client: TelegramClient, peerId: string): Promise<BotCommand[]> {
  const entity = await client.getEntity(peer(peerId));
  let infos: (Api.BotInfo | undefined)[] = [];
  if (entity instanceof Api.User) {
    if (!entity.bot) return [];
    infos = [(await client.invoke(new Api.users.GetFullUser({ id: entity }))).fullUser.botInfo];
  } else if (entity instanceof Api.Chat) {
    const full = (await client.invoke(new Api.messages.GetFullChat({ chatId: entity.id }))).fullChat;
    infos = full instanceof Api.ChatFull ? (full.botInfo ?? []) : [];
  } else if (entity instanceof Api.Channel) {
    const full = (await client.invoke(new Api.channels.GetFullChannel({ channel: entity }))).fullChat;
    infos = full instanceof Api.ChannelFull ? (full.botInfo ?? []) : [];
  }
  const seen = new Set<string>();
  return infos.flatMap((info) => toCommands(info?.commands)).filter((c) => !seen.has(c.command) && seen.add(c.command));
}

export const telegramConnector: Connector = {
  channel: "telegram",

  async deleteMessages(ctx, conversation, externalIds, { forEveryone }) {
    const client = await clientFor(ctx);
    // revoke = "also delete for the other side". Supergroups always delete for everyone
    // (and only allow it for your own messages unless you're an admin).
    await client.deleteMessages(peer(conversation.externalId), externalIds.map(Number), { revoke: forEveryone });
  },

  async deleteConversation(ctx, conversation, { forEveryone, keepChat }) {
    const client = await clientFor(ctx);
    const entity = (await client.getEntity(peer(conversation.externalId))) as Entity;
    if (entity instanceof Api.Channel) {
      // Supergroup: "delete chat" means leaving it, as in the Telegram app.
      if (keepChat) await client.invoke(new Api.channels.DeleteHistory({ channel: entity, forEveryone: false, maxId: 0 }));
      else await client.invoke(new Api.channels.LeaveChannel({ channel: entity }));
      return;
    }
    if (entity instanceof Api.Chat && !keepChat) {
      // Basic group: leave it, then remove the emptied chat from the list.
      await client.invoke(new Api.messages.DeleteChatUser({ chatId: entity.id, userId: new Api.InputUserSelf(), revokeHistory: false }));
    }
    // Private chats, bots, and the leftover basic-group chat. Telegram deletes in batches.
    for (let i = 0; i < 50; i++) {
      const res = await client.invoke(
        new Api.messages.DeleteHistory({ peer: entity, justClear: keepChat, revoke: forEveryone && entity instanceof Api.User, maxId: 0 }),
      );
      if (!res.offset) break;
    }
  },

  async compose(ctx, { to, text, html }) {
    const client = await clientFor(ctx);
    const target = to.trim();
    let entity: Entity | undefined;
    if (/^\+?[\d\s()-]{7,}$/.test(target)) {
      // Only finds people whose privacy settings let others find them by phone number.
      const resolved = await client.invoke(new Api.contacts.ResolvePhone({ phone: target.replace(/\D/g, "") })).catch(() => null);
      entity = resolved?.users.find((u): u is Api.User => u instanceof Api.User);
      if (!entity) throw new Error("No Telegram account found for that number, or they only let contacts find them. Try their @username.");
    } else {
      entity = (await client.getEntity(target.replace(/^@/, "")).catch(() => undefined)) as Entity | undefined;
      if (!entity) throw new Error(`No Telegram user, bot or group called @${target.replace(/^@/, "")}.`);
    }
    if (isBroadcast(entity) && !canPost(entity as Api.Channel)) throw new Error("That's a broadcast channel — only its admins can post there.");

    const sent = await client.sendMessage(entity, html ? { message: html, parseMode: "html" } : { message: text, parseMode: false });
    const conversationId = await upsertConversation(ctx.account.id, { externalId: utils.getPeerId(entity), name: entityName(entity) });
    await upsertMessage(conversationId, { externalId: String(sent.id), direction: "out", text, html: html ?? null, sentAt: sent.date * 1000, silent: true });
    await syncPhoto(client, conversationId, entity).catch((err) => ctx.log("photo failed", err));
    return { conversationId };
  },

  async pressButton(ctx, conversation, messageExternalId, button) {
    if (button.kind !== "callback" || !button.data) throw new Error("This button only works in the Telegram app");
    const client = await clientFor(ctx);
    try {
      const answer = await client.invoke(
        new Api.messages.GetBotCallbackAnswer({
          peer: peer(conversation.externalId),
          msgId: Number(messageExternalId),
          data: Buffer.from(button.data, "base64"),
        }),
      );
      return { answer: answer.message, url: answer.url };
    } catch (error) {
      // Slow bots time out here but still act on the press (usually by editing the message).
      if (/BOT_RESPONSE_TIMEOUT/.test(String((error as Error)?.message))) return {};
      throw error;
    }
  },

  async botInfo(ctx, conversation) {
    const meta = (conversation.meta ?? {}) as ConvoMeta;
    let commands = meta.commands;
    if (!commands || !meta.commandsAt || Date.now() - meta.commandsAt > COMMANDS_TTL_MS) {
      const client = await clientFor(ctx);
      commands = await fetchCommands(client, conversation.externalId).catch((err) => {
        ctx.log("commands failed", err);
        return meta.commands ?? [];
      });
      await patchMeta(conversation.id, { commands, commandsAt: Date.now() });
    }
    return { commands, keyboard: meta.keyboard ?? null };
  },

  async start(ctx) {
    const creds = ctx.getCredentials<TelegramCredentials>();
    if (!creds) throw new Error("Telegram is not signed in");
    let stopped = false;
    let client: TelegramClient | null = null;
    let failures = 0;
    let timer: NodeJS.Timeout | undefined;
    let inFlight: Promise<void> | null = null;

    // A fresh client each time: after GramJS gives up retrying, the old one never recovers.
    const boot = async () => {
      if (client) await client.destroy().catch(() => {});
      const c = telegramClient(creds.session);
      client = c;
      clients.set(ctx.account.id, c);
      await c.connect();
      if (!(await c.checkAuthorization())) {
        stopped = true;
        await ctx.setStatus("error", "Telegram signed Sangam out — reconnect Telegram");
        return;
      }
      c.addEventHandler((e: NewMessageEvent) => void onNewMessage(ctx, e).catch((err) => ctx.log("message failed", err)), new NewMessage({}));
      c.addEventHandler((e: EditedMessageEvent) => void onEdited(ctx, e).catch((err) => ctx.log("edit failed", err)), new EditedMessage({}));
      c.addEventHandler((u: Api.TypeUpdate) => {
        void onReadElsewhere(ctx, u).catch((err) => ctx.log("read sync failed", err));
        void onDeleted(ctx, u).catch((err) => ctx.log("delete sync failed", err));
      }, new Raw({}));
      if (!ctx.getSyncState<{ backfilled: boolean }>()?.backfilled) await ctx.setStatus("connected", "Syncing your chats…");
      // Every (re)connect refreshes recent chats: dedupe makes it cheap, and it catches up on anything missed while offline.
      await backfill(ctx, c);
      await ctx.saveSyncState({ backfilled: true });
      if (failures) ctx.log("back online");
      failures = 0;
      await ctx.setStatus("connected");
    };

    /** Watchdog: checks the connection every 30s and reconnects with backoff (5s → 1 min), forever. */
    const ensure = () => {
      inFlight ??= (async () => {
        clearTimeout(timer);
        try {
          if (!stopped && !client?.connected) await boot();
        } catch (error) {
          if (isSessionRevoked(error)) {
            stopped = true;
            await ctx.setStatus("error", "This Telegram session was ended — reconnect Telegram");
          } else {
            failures++;
            ctx.log(`offline (attempt ${failures}), retrying:`, (error as Error)?.message ?? error);
            await ctx.setStatus("connected", "Offline — reconnecting…");
          }
        } finally {
          inFlight = null;
          if (!stopped) timer = setTimeout(ensure, failures ? Math.min(60_000, 5_000 * 2 ** (failures - 1)) : 30_000);
        }
      })();
      return inFlight;
    };
    reconnectors.set(ctx.account.id, ensure);
    // Refresh: re-read recent chats (cheap: already-stored messages are skipped), or reconnect if offline.
    ctx.onRefresh(async () => {
      const c = client;
      if (!c?.connected) return void (await ensure());
      await ctx.job({ name: "sync", label: "Syncing Telegram", priority: "low", dedupe: true, timeoutMs: 30 * 60_000 }, () => backfill(ctx, c));
    });
    void ensure();

    return async () => {
      stopped = true;
      clearTimeout(timer);
      reconnectors.delete(ctx.account.id);
      clients.delete(ctx.account.id);
      await client?.destroy().catch(() => {});
    };
  },

  async send(ctx, conversation, text, files, opts) {
    const client = await clientFor(ctx);
    // Formatted messages go as Telegram HTML; plain ones exactly as typed (no Markdown surprises).
    const body = opts?.html ? { message: opts.html, parseMode: "html" as const } : { message: text, parseMode: false as const };
    if (!files.length) {
      const sent = await client.sendMessage(peer(conversation.externalId), body);
      return { externalId: String(sent.id), direction: "out", text, sentAt: sent.date * 1000, silent: true };
    }
    // One message per file, the typed text as the first one's caption — like the Telegram app.
    const out = [];
    for (const [i, f] of files.entries()) {
      const caption = i === 0 ? text : "";
      const sent = await client.sendFile(peer(conversation.externalId), {
        file: new CustomFile(f.name, f.data.length, "", f.data),
        caption: i === 0 ? body.message : "",
        parseMode: body.parseMode,
        // Photos and videos are shown inline; anything else is sent as a file with its name.
        forceDocument: !/^(image\/(jpeg|png|webp)|video\/mp4)$/.test(f.mime),
        workers: 2,
      });
      out.push({
        externalId: String(sent.id),
        direction: "out" as const,
        text: caption || mediaLabelFor(f.mime, f.name),
        sentAt: sent.date * 1000,
        silent: true,
        ...(!caption && { extra: { mediaLabel: true } }),
        attachments: [{ key: "media", name: f.name, mime: f.mime, size: f.data.length, ref: { peer: conversation.externalId, msgId: sent.id }, data: f.data }],
      });
    }
    return out;
  },

  async downloadAttachment(ctx, conversation, attachment) {
    const client = await clientFor(ctx);
    const [msg] = await client.getMessages(peer(conversation.externalId), { ids: Number(attachment.ref.msgId) });
    if (!msg?.media) throw new Error("This file is no longer available in Telegram");
    const data = await client.downloadMedia(msg, {});
    if (!Buffer.isBuffer(data) || !data.length) throw new Error("Telegram didn't return this file");
    return data;
  },

  async downloadThumbnail(ctx, conversation, attachment) {
    const client = await clientFor(ctx);
    const read = async (fresh: boolean) => {
      const media = await messageMedia(client, conversation.externalId, Number(attachment.ref.msgId), fresh);
      const size = previewSize(media);
      if (!size) return null;
      const data = await client.downloadMedia(media, { thumb: size });
      return Buffer.isBuffer(data) && data.length ? data : null;
    };
    return read(false).catch((error) => (isExpiredReference(error) ? read(true) : Promise.reject(error)));
  },

  async streamAttachment(ctx, conversation, attachment, start, end) {
    const client = await clientFor(ctx);
    // Telegram serves files in aligned blocks: fetch the blocks covering start..end, then trim.
    const aligned = start - (start % STREAM_CHUNK);
    const blocks = Math.ceil((end + 1 - aligned) / STREAM_CHUNK);
    const read = async (fresh: boolean) => {
      const media = await messageMedia(client, conversation.externalId, Number(attachment.ref.msgId), fresh);
      const parts: Buffer[] = [];
      for await (const part of client.iterDownload({
        file: media as unknown as Api.TypeInputFileLocation,
        offset: returnBigInt(aligned),
        limit: blocks,
        requestSize: STREAM_CHUNK,
      })) parts.push(Buffer.from(part));
      return Buffer.concat(parts);
    };
    const data = await read(false).catch((error) => (isExpiredReference(error) ? read(true) : Promise.reject(error)));
    return data.subarray(start - aligned, end + 1 - aligned);
  },

  async loadOlder(ctx, conversation, beforeExternalId, limit) {
    const client = await clientFor(ctx);
    const entity = (await client.getEntity(peer(conversation.externalId))) as Entity;
    const messages = await client.getMessages(entity, { limit, offsetId: Number(beforeExternalId) || 0 });
    for (const m of [...messages].reverse()) await storeMessage(conversation.id, m, entity, true, true);
    return { added: messages.length, done: messages.length < limit };
  },

  async members(ctx, conversation) {
    const client = await clientFor(ctx);
    const entity = (await client.getEntity(peer(conversation.externalId))) as Entity;
    if (entity instanceof Api.User) return null;
    let count = entity instanceof Api.Chat ? entity.participantsCount : (entity as Api.Channel).participantsCount;
    // The short channel info often leaves the count out; the full info always has it.
    if (count == null && entity instanceof Api.Channel) {
      const full = await client.invoke(new Api.channels.GetFullChannel({ channel: entity })).catch(() => null);
      if (full?.fullChat instanceof Api.ChannelFull) count = full.fullChat.participantsCount ?? undefined;
    }
    if (isBroadcast(entity) && !canPost(entity as Api.Channel)) {
      return { total: count ?? 0, members: [], note: "Telegram only shows a channel's subscribers to its admins." };
    }
    const me = await client.getMe();
    try {
      const users = await client.getParticipants(entity, { limit: MEMBER_LIMIT });
      const members = users.map((u): GroupMember => ({
        id: u.id.toString(),
        name: entityName(u),
        handle: u.username ? `@${u.username}` : u.phone ? `+${u.phone}` : null,
        role: roleOf((u as Api.User & { participant?: unknown }).participant),
        you: u.id.equals(me.id),
      }));
      return { total: Math.max(users.total ?? 0, count ?? 0, members.length), members };
    } catch (error) {
      if (/CHAT_ADMIN_REQUIRED|PARTICIPANTS_HIDDEN/.test(String((error as Error)?.message))) {
        return { total: count ?? 0, members: [], note: "This group's admins have hidden the member list." };
      }
      throw error;
    }
  },

  async markRead(ctx, conversation) {
    const client = await clientFor(ctx);
    await client.markAsRead(peer(conversation.externalId));
  },

  async disconnect(ctx) {
    // Ends the session on Telegram's side too, so it disappears from Settings → Devices.
    // The running client is already stopped by now, so log out on a fresh connection.
    const creds = ctx.getCredentials<TelegramCredentials>();
    if (!creds) return;
    const client = telegramClient(creds.session);
    try {
      await client.connect();
      await client.invoke(new Api.auth.LogOut());
    } finally {
      await client.destroy().catch(() => {});
    }
  },
};
