import { and, desc, eq, like } from "drizzle-orm";
import makeWASocket, {
  Browsers,
  BufferJSON,
  DisconnectReason,
  downloadMediaMessage,
  getContentType,
  initAuthCreds,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type ConnectionState,
  type Contact,
  type SignalDataSet,
  type SignalDataTypeMap,
  type WAMessage,
  type WASocket,
} from "baileys";
import { clearAvatar, saveAvatar } from "../avatars";
import { db, schema } from "../db";
import { emit } from "../events";
import { hideMessages, mergeConversation, updateMessage, upsertConversation, upsertMessage, type IncomingAttachment } from "../store";
import type { Connector, ConnectorContext, OutgoingFile } from "./types";

/*
 * WhatsApp via Baileys: Sangam links as a device (like WhatsApp Web). This is NOT an official
 * API — WhatsApp may ban numbers that use it — so the connector stays deliberately quiet:
 * no "online" presence, no typing indicators, no automatic read receipts, gentle photo fetching.
 */

export type WhatsAppCredentials = { auth: string };

const RECENT_CHATS = 50;
const MESSAGES_PER_CHAT = 20;

// Baileys logs through pino by default (very chatty); keep only errors.
const quietLogger = {
  level: "error",
  child() {
    return quietLogger;
  },
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error(obj: unknown, msg?: string) {
    console.error("[whatsapp]", msg ?? "", obj instanceof Error ? obj.message : "");
  },
};

// ---------- Encrypted auth state ----------

type StoredAuth = { creds: AuthenticationCreds; keys: Record<string, Record<string, unknown>> };

/**
 * Baileys' linked-device identity (creds + signal keys) kept in memory and persisted through
 * `persist` — which writes it encrypted into the account. Writes are debounced: keys change
 * on almost every message.
 */
export function makeAuthState(serialized: string | null, persist: (json: string) => Promise<void>) {
  const data: StoredAuth = serialized ? JSON.parse(serialized, BufferJSON.reviver) : { creds: initAuthCreds(), keys: {} };
  let timer: NodeJS.Timeout | undefined;
  const serialize = () => JSON.stringify(data, BufferJSON.replacer);
  const save = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void persist(serialize()).catch((e) => console.error("[whatsapp] saving keys failed", e)), 1000);
  };
  const state: AuthenticationState = {
    creds: data.creds,
    keys: {
      get: (type, ids) => {
        const out: { [id: string]: SignalDataTypeMap[typeof type] } = {};
        for (const id of ids) {
          let value = data.keys[type]?.[id];
          if (value && type === "app-state-sync-key") value = proto.Message.AppStateSyncKeyData.fromObject(value as object);
          if (value !== undefined) out[id] = value as SignalDataTypeMap[typeof type];
        }
        return out;
      },
      set: (set: SignalDataSet) => {
        for (const type of Object.keys(set) as (keyof SignalDataTypeMap)[]) {
          const bucket = (data.keys[type] ??= {});
          for (const [id, value] of Object.entries(set[type] ?? {})) {
            if (value) bucket[id] = value;
            else delete bucket[id];
          }
        }
        save();
      },
    },
  };
  return { state, save, serialize, flush: () => persist(serialize()) };
}

export function makeSocket(auth: AuthenticationState) {
  return makeWASocket({
    auth: { creds: auth.creds, keys: makeCacheableSignalKeyStore(auth.keys, quietLogger) },
    logger: quietLogger,
    browser: Browsers.windows("Sangam"),
    // Stay invisible: never mark the account online, and don't pull years of history.
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
  });
}

export const disconnectCode = (update: Partial<ConnectionState>) =>
  (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;

// ---------- Message parsing ----------

const isSkippedJid = (jid: string) => isJidBroadcast(jid) || isJidNewsletter(jid) || jid === "status@broadcast";

const labelFor = (mime: string, name: string) =>
  mime.startsWith("image/") ? "📷 Photo" : mime.startsWith("video/") ? "🎬 Video" : mime.startsWith("audio/") ? "🎤 Voice message" : `📎 ${name}`;

/** Text, and the downloadable file if any, of a WhatsApp message. Null for non-content (reactions, protocol…). */
function parseMessage(msg: WAMessage) {
  const content = normalizeMessageContent(msg.message);
  if (!content) return null;
  const type = getContentType(content);
  if (!type) return null;
  const id = msg.key.id ?? "";
  const text = content.conversation ?? content.extendedTextMessage?.text ?? null;
  const media =
    type === "imageMessage" ? { m: content.imageMessage!, name: `photo-${id}.jpg`, caption: content.imageMessage!.caption }
    : type === "videoMessage" ? { m: content.videoMessage!, name: `video-${id}.mp4`, caption: content.videoMessage!.caption }
    : type === "audioMessage" ? { m: content.audioMessage!, name: `voice-${id}.ogg`, caption: null }
    : type === "documentMessage" ? { m: content.documentMessage!, name: content.documentMessage!.fileName || `file-${id}`, caption: content.documentMessage!.caption }
    : type === "documentWithCaptionMessage" ? null
    : type === "stickerMessage" ? { m: content.stickerMessage!, name: `sticker-${id}.webp`, caption: null }
    : null;
  if (media) {
    const mime = media.m.mimetype || "application/octet-stream";
    const attachment: IncomingAttachment = {
      key: "media",
      name: media.name,
      mime: mime.split(";")[0]!.trim(),
      size: media.m.fileLength ? Number(media.m.fileLength) : null,
      // The whole message is what Baileys needs to download (and re-request) the media later.
      ref: { message: JSON.stringify(msg, BufferJSON.replacer) },
    };
    return { text: media.caption || labelFor(attachment.mime, attachment.name), mediaLabel: !media.caption, attachment };
  }
  if (text) return { text, mediaLabel: false, attachment: null };
  if (type === "locationMessage" || type === "liveLocationMessage") return { text: "📍 Location", mediaLabel: false, attachment: null };
  if (type === "contactMessage" || type === "contactsArrayMessage") return { text: "👤 Contact", mediaLabel: false, attachment: null };
  if (type === "pollCreationMessage" || type === "pollCreationMessageV3") return { text: `📊 Poll: ${content.pollCreationMessage?.name ?? content.pollCreationMessageV3?.name ?? ""}`, mediaLabel: false, attachment: null };
  return null;
}

// ---------- Live sockets ----------

const sockets = new Map<number, WASocket>();
const reconnectors = new Map<number, () => Promise<void>>();

async function socketFor(ctx: ConnectorContext) {
  const isOpen = (s: WASocket | undefined) => !!s?.user && (s.ws as { isOpen?: boolean }).isOpen !== false;
  if (!isOpen(sockets.get(ctx.account.id))) {
    const reconnect = reconnectors.get(ctx.account.id);
    if (reconnect) await Promise.race([reconnect(), new Promise((r) => setTimeout(r, 15_000))]);
  }
  const sock = sockets.get(ctx.account.id);
  if (sock?.user) return sock;
  throw new Error("WhatsApp is offline right now — Sangam keeps reconnecting automatically; try again in a minute");
}

/** "+91 98765 43210"-ish from a JID, for chats with no saved name. */
// Only real phone-number JIDs become "+<number>". A LID (WhatsApp's hidden privacy id) isn't a
// phone number and must never be shown as one.
const phoneOf = (jid: string) => (jid.endsWith("@s.whatsapp.net") ? `+${jid.split("@")[0]!.split(":")[0]}` : "WhatsApp contact");
const isLid = (jid: string) => jid.endsWith("@lid");

const toJid = (to: string) => `${to.replace(/\D/g, "")}@s.whatsapp.net`;

export const whatsappConnector: Connector = {
  channel: "whatsapp",

  async start(ctx) {
    const creds = ctx.getCredentials<WhatsAppCredentials>();
    if (!creds) throw new Error("WhatsApp is not linked");
    const auth = makeAuthState(creds.auth, (json) => ctx.saveCredentials({ auth: json } satisfies WhatsAppCredentials));
    let stopped = false;
    let failures = 0;
    let timer: NodeJS.Timeout | undefined;
    let sock: WASocket | null = null;

    // Names and LID→phone mappings learned during sync (WhatsApp now addresses some chats by "LID").
    const names = new Map<string, string>();
    const lidToPn = new Map<string, string>();
    const chatJid = (jid: string, alt?: string | null) => {
      const normal = jidNormalizedUser(jid);
      if (isLid(normal)) return alt && !isLid(alt) ? jidNormalizedUser(alt) : (lidToPn.get(normal) ?? normal);
      return normal;
    };

    /**
     * Records that a hidden LID belongs to a phone number, and folds any chat stored under the
     * LID into the phone-number chat (or renames it), so one person is never two chats.
     */
    const learn = async (lidJid: string | null | undefined, pnJid: string | null | undefined) => {
      if (!lidJid || !pnJid) return;
      const lid = jidNormalizedUser(lidJid);
      const pn = jidNormalizedUser(pnJid);
      if (!isLid(lid) || isLid(pn) || lidToPn.get(lid) === pn) return;
      lidToPn.set(lid, pn);
      const byExternal = (externalId: string) =>
        db.query.conversations.findFirst({ where: and(eq(schema.conversations.accountId, ctx.account.id), eq(schema.conversations.externalId, externalId)) });
      const lidConvo = await byExternal(lid);
      if (!lidConvo) return;
      const pnConvo = await byExternal(pn);
      if (pnConvo) {
        await mergeConversation(lidConvo.id, pnConvo.id);
      } else {
        await db
          .update(schema.conversations)
          .set({ externalId: pn, name: names.get(pn) || names.get(lid) || (lidConvo.name === "WhatsApp contact" || lidConvo.name.startsWith("+") ? phoneOf(pn) : lidConvo.name) })
          .where(eq(schema.conversations.id, lidConvo.id));
        emit({ type: "conversation", id: lidConvo.id });
      }
    };

    /** Looks a LID up in Baileys' own mapping store (kept with the linked-device keys). */
    const resolve = async (jid: string | null | undefined) => {
      if (!jid) return;
      const normal = jidNormalizedUser(jid);
      if (!isLid(normal) || lidToPn.has(normal)) return;
      const pn = await sock?.signalRepository.lidMapping.getPNForLID(normal).catch(() => null);
      if (pn) await learn(normal, pn);
    };

    /** On every (re)connect: resolve chats still stored under a LID, merging duplicates. */
    const reconcile = async () => {
      const lidChats = await db
        .select({ id: schema.conversations.id, externalId: schema.conversations.externalId, name: schema.conversations.name })
        .from(schema.conversations)
        .where(and(eq(schema.conversations.accountId, ctx.account.id), like(schema.conversations.externalId, "%@lid")));
      for (const c of lidChats) {
        await resolve(c.externalId);
        // Still unknown: at least stop showing the hidden id as if it were a phone number.
        if (!lidToPn.has(c.externalId) && /^\+\d+$/.test(c.name)) {
          await db.update(schema.conversations).set({ name: names.get(c.externalId) || "WhatsApp contact" }).where(eq(schema.conversations.id, c.id));
          emit({ type: "conversation", id: c.id });
        }
      }
    };
    const nameOf = (jid: string, fallback?: string | null) => names.get(jid) || fallback || (isJidGroup(jid) ? "Group" : phoneOf(jid));

    // Profile photos are fetched one at a time with a pause, so the account never looks like a bot.
    const photoQueue: { jid: string; convoId: number }[] = [];
    let photoBusy = false;
    const queuePhoto = (jid: string, convoId: number) => {
      photoQueue.push({ jid, convoId });
      if (photoBusy) return;
      photoBusy = true;
      void (async () => {
        while (photoQueue.length && !stopped) {
          const { jid: j, convoId } = photoQueue.shift()!;
          try {
            const url = await sock?.profilePictureUrl(j, "preview").catch(() => undefined);
            if (url) {
              const res = await fetch(url);
              if (res.ok) await saveAvatar(convoId, Buffer.from(await res.arrayBuffer()));
            } else await clearAvatar(convoId);
          } catch {
            /* a missing photo just leaves the initials */
          }
          await new Promise((r) => setTimeout(r, 1500));
        }
        photoBusy = false;
      })();
    };

    const conversationFor = async (jid: string, name?: string | null) => {
      const existing = await db.query.conversations.findFirst({
        where: and(eq(schema.conversations.accountId, ctx.account.id), eq(schema.conversations.externalId, jid)),
      });
      if (existing) {
        const better = names.get(jid) || name;
        if (better && better !== existing.name && existing.name.startsWith("+")) await upsertConversation(ctx.account.id, { externalId: jid, name: better });
        return existing.id;
      }
      const id = await upsertConversation(ctx.account.id, { externalId: jid, name: nameOf(jid, name) });
      queuePhoto(jid, id);
      return id;
    };

    const storeMessage = async (msg: WAMessage, silent: boolean) => {
      const raw = msg.key.remoteJid;
      if (!raw || isSkippedJid(raw) || !msg.key.id) return;
      const content = normalizeMessageContent(msg.message);
      const key = msg.key as { remoteJidAlt?: string; participantAlt?: string };
      // Learn LID→phone pairs from the message itself before deciding which chat it belongs to.
      if (isLid(raw)) await (key.remoteJidAlt ? learn(raw, key.remoteJidAlt) : resolve(raw));
      if (msg.key.participant && isLid(msg.key.participant)) await (key.participantAlt ? learn(msg.key.participant, key.participantAlt) : resolve(msg.key.participant));
      const jid = chatJid(raw, key.remoteJidAlt);

      // Edits and "delete for everyone" arrive as protocol messages about an earlier message.
      const protocol = content?.protocolMessage;
      if (protocol?.key?.id) {
        const convo = await db.query.conversations.findFirst({
          where: and(eq(schema.conversations.accountId, ctx.account.id), eq(schema.conversations.externalId, jid)),
        });
        if (!convo) return;
        if (protocol.type === proto.Message.ProtocolMessage.Type.REVOKE) await hideMessages([convo.id], [protocol.key.id]);
        if (protocol.type === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT && protocol.editedMessage) {
          const edited = parseMessage({ ...msg, message: protocol.editedMessage });
          if (edited) await updateMessage(convo.id, protocol.key.id, { text: edited.text });
        }
        return;
      }

      const parsed = parseMessage(msg);
      if (!parsed) return;
      const fromMe = !!msg.key.fromMe;
      const group = !!isJidGroup(jid);
      const participant = group ? (msg.key.participant ?? undefined) : undefined;
      const sender = fromMe ? null : group ? msg.pushName || (participant ? nameOf(chatJid(participant)) : "Someone") : msg.pushName || nameOf(jid);
      if (!fromMe && !group && msg.pushName && !names.has(jid)) names.set(jid, msg.pushName);
      const convoId = await conversationFor(jid, group ? null : msg.pushName);
      const extra = parsed.mediaLabel || participant ? { ...(parsed.mediaLabel && { mediaLabel: true }), ...(participant && { participant }) } : null;
      await upsertMessage(convoId, {
        externalId: msg.key.id,
        direction: fromMe ? "out" : "in",
        senderName: sender,
        // Group messages show who wrote them, like the Telegram connector does.
        text: group && !fromMe && !parsed.mediaLabel ? `${sender}: ${parsed.text}` : parsed.text,
        sentAt: Number(msg.messageTimestamp ?? Math.floor(Date.now() / 1000)) * 1000,
        silent,
        extra,
        ...(parsed.attachment && { attachments: [parsed.attachment] }),
      });
    };

    const connect = async () => {
      if (stopped) return;
      sock?.end(undefined);
      const s = makeSocket(auth.state);
      sock = s;
      sockets.set(ctx.account.id, s);
      s.ev.on("creds.update", auth.save);

      s.ev.on("connection.update", (update) => {
        if (update.connection === "open") {
          void reconcile().catch((e) => ctx.log("LID clean-up failed", e));
          if (failures) ctx.log("back online");
          failures = 0;
          void ctx.setStatus("connected");
        }
        if (update.connection === "close" && sock === s) {
          const code = disconnectCode(update);
          if (code === DisconnectReason.loggedOut) {
            stopped = true;
            void ctx.setStatus("error", "WhatsApp unlinked Sangam — link it again from Profile");
            return;
          }
          // restartRequired is routine (WhatsApp asks for it after linking); reconnect straight away.
          failures = code === DisconnectReason.restartRequired ? 0 : failures + 1;
          if (failures) void ctx.setStatus("connected", "Offline — reconnecting…");
          clearTimeout(timer);
          timer = setTimeout(() => void connect(), failures ? Math.min(60_000, 2_000 * 2 ** (failures - 1)) : 500);
        }
      });

      s.ev.on("lid-mapping.update", (m) => void learn(m.lid, m.pn).catch((e) => ctx.log("LID mapping failed", e)));
      // Contacts carry both ids (id/lid/phoneNumber) — another source of LID→phone pairs.
      const onContacts = async (contacts: Partial<Contact>[]) => {
        for (const c of contacts) {
          if (!c.id) continue;
          await learn(c.lid ?? (isLid(c.id) ? c.id : null), c.phoneNumber ?? (isLid(c.id) ? null : c.id));
          const name = c.name || c.notify || c.verifiedName;
          if (name) names.set(chatJid(c.id), name);
        }
      };
      s.ev.on("contacts.upsert", (contacts) => void onContacts(contacts).catch((e) => ctx.log("contacts failed", e)));
      s.ev.on("contacts.update", (contacts) => void onContacts(contacts).catch((e) => ctx.log("contacts failed", e)));

      // First link: WhatsApp pushes recent history. Keep only the most recent chats and messages.
      s.ev.on("messaging-history.set", ({ chats, contacts, messages, lidPnMappings }) => {
        void (async () => {
          for (const m of lidPnMappings ?? []) await learn(m.lid, m.pn);
          await onContacts(contacts);
          for (const c of chats) await resolve(c.id);
          for (const c of chats) if (c.id && c.name) names.set(chatJid(c.id), c.name);
          const recent = chats
            .filter((c) => c.id && !isSkippedJid(c.id))
            .sort((a, b) => Number(b.conversationTimestamp ?? 0) - Number(a.conversationTimestamp ?? 0))
            .slice(0, RECENT_CHATS);
          const keep = new Set(recent.map((c) => chatJid(c.id!)));
          const byChat = new Map<string, WAMessage[]>();
          for (const m of messages) {
            if (!m.key.remoteJid) continue;
            const jid = chatJid(m.key.remoteJid, (m.key as { remoteJidAlt?: string }).remoteJidAlt);
            if (keep.has(jid)) byChat.set(jid, [...(byChat.get(jid) ?? []), m]);
          }
          for (const list of byChat.values()) {
            list.sort((a, b) => Number(a.messageTimestamp ?? 0) - Number(b.messageTimestamp ?? 0));
            for (const m of list.slice(-MESSAGES_PER_CHAT)) await storeMessage(m, true);
          }
          for (const c of recent) {
            const convo = await db.query.conversations.findFirst({
              where: and(eq(schema.conversations.accountId, ctx.account.id), eq(schema.conversations.externalId, chatJid(c.id!))),
            });
            if (convo && typeof c.unreadCount === "number" && c.unreadCount >= 0) {
              await db.update(schema.conversations).set({ unread: c.unreadCount }).where(eq(schema.conversations.id, convo.id));
              emit({ type: "conversation", id: convo.id });
            }
          }
        })().catch((e) => ctx.log("history sync failed", e));
      });

      s.ev.on("messages.upsert", ({ messages, type }) => {
        void (async () => {
          for (const m of messages) await storeMessage(m, type !== "notify");
        })().catch((e) => ctx.log("message failed", e));
      });

      // Reading on the phone clears the unread count here too.
      s.ev.on("chats.update", (updates) => {
        void (async () => {
          for (const u of updates) {
            if (!u.id || typeof u.unreadCount !== "number") continue;
            await resolve(u.id);
            const convo = await db.query.conversations.findFirst({
              where: and(eq(schema.conversations.accountId, ctx.account.id), eq(schema.conversations.externalId, chatJid(u.id))),
            });
            if (!convo || convo.unread === u.unreadCount) continue;
            await db.update(schema.conversations).set({ unread: Math.max(0, u.unreadCount) }).where(eq(schema.conversations.id, convo.id));
            emit({ type: "conversation", id: convo.id });
          }
        })().catch((e) => ctx.log("chat update failed", e));
      });

      s.ev.on("messages.delete", (del) => {
        void (async () => {
          if (!("keys" in del)) return;
          for (const key of del.keys) {
            if (!key.remoteJid || !key.id) continue;
            await resolve(key.remoteJid);
            const convo = await db.query.conversations.findFirst({
              where: and(eq(schema.conversations.accountId, ctx.account.id), eq(schema.conversations.externalId, chatJid(key.remoteJid))),
            });
            if (convo) await hideMessages([convo.id], [key.id]);
          }
        })().catch((e) => ctx.log("delete sync failed", e));
      });
    };

    reconnectors.set(ctx.account.id, async () => {
      if (!stopped && !sock?.user) await connect();
    });
    await connect();

    return async () => {
      stopped = true;
      clearTimeout(timer);
      reconnectors.delete(ctx.account.id);
      sockets.delete(ctx.account.id);
      sock?.end(undefined);
      await auth.flush().catch(() => {});
    };
  },

  async send(ctx, conversation, text, files) {
    const sock = await socketFor(ctx);
    const jid = conversation.externalId;
    if (!files.length) {
      const sent = await sock.sendMessage(jid, { text });
      return { externalId: sent!.key.id!, direction: "out", text, sentAt: Date.now(), silent: true };
    }
    const out = [];
    for (const [i, f] of files.entries()) {
      const caption = i === 0 ? text : "";
      const sent = await sock.sendMessage(jid, mediaContent(f, caption));
      out.push({
        externalId: sent!.key.id!,
        direction: "out" as const,
        text: caption || labelFor(f.mime, f.name),
        sentAt: Date.now(),
        silent: true,
        ...(!caption && { extra: { mediaLabel: true } }),
        attachments: [{ key: "media", name: f.name, mime: f.mime, size: f.data.length, ref: { message: JSON.stringify(sent, BufferJSON.replacer) }, data: f.data }],
      });
    }
    return out;
  },

  async downloadAttachment(ctx, _conversation, attachment) {
    const sock = await socketFor(ctx);
    const msg = JSON.parse(String(attachment.ref.message), BufferJSON.reviver) as WAMessage;
    // reuploadRequest lets WhatsApp re-send media whose download link has expired.
    return downloadMediaMessage(msg, "buffer", {}, { logger: quietLogger, reuploadRequest: sock.updateMediaMessage });
  },

  // Explicit reads only (opening the chat in Sangam) — WhatsApp then shows blue ticks to the sender.
  async markRead(ctx, conversation) {
    const sock = await socketFor(ctx);
    const unread = await db
      .select({ id: schema.messages.externalId, extra: schema.messages.extra })
      .from(schema.messages)
      .where(and(eq(schema.messages.conversationId, conversation.id), eq(schema.messages.direction, "in")))
      .orderBy(desc(schema.messages.sentAt))
      .limit(Math.max(1, Math.min(conversation.unread || 1, 20)));
    if (!unread.length) return;
    await sock.readMessages(unread.map((m) => ({ remoteJid: conversation.externalId, id: m.id, fromMe: false, ...(m.extra?.participant && { participant: m.extra.participant }) })));
  },

  async deleteMessages(ctx, conversation, externalIds, { forEveryone }) {
    const sock = await socketFor(ctx);
    for (const id of externalIds) {
      const row = await db.query.messages.findFirst({ where: and(eq(schema.messages.conversationId, conversation.id), eq(schema.messages.externalId, id)) });
      if (!row) continue;
      const key = { remoteJid: conversation.externalId, id, fromMe: row.direction === "out", ...(row.extra?.participant && { participant: row.extra.participant }) };
      // "For everyone" only works on your own messages; anything else is deleted just for you.
      if (forEveryone && row.direction === "out") await sock.sendMessage(conversation.externalId, { delete: key });
      else await sock.chatModify({ deleteForMe: { deleteMedia: true, key, timestamp: Math.floor(row.sentAt / 1000) } }, conversation.externalId);
    }
  },

  async deleteConversation(ctx, conversation, { keepChat }) {
    const sock = await socketFor(ctx);
    if (isJidGroup(conversation.externalId) && !keepChat) {
      // Like the WhatsApp app: deleting a group means leaving it first.
      await sock.groupLeave(conversation.externalId);
    }
    const last = await db.query.messages.findFirst({ where: eq(schema.messages.conversationId, conversation.id), orderBy: desc(schema.messages.sentAt) });
    if (!last) return;
    const lastMessages = [{ key: { remoteJid: conversation.externalId, id: last.externalId, fromMe: last.direction === "out" }, messageTimestamp: Math.floor(last.sentAt / 1000) }];
    await sock.chatModify(keepChat ? { clear: true, lastMessages } : { delete: true, lastMessages }, conversation.externalId);
  },

  async compose(ctx, { to, text }) {
    const sock = await socketFor(ctx);
    const jid = toJid(to);
    const [found] = (await sock.onWhatsApp(jid)) ?? [];
    if (!found?.exists) throw new Error("That number isn't on WhatsApp.");
    const target = jidNormalizedUser(found.jid);
    const sent = await sock.sendMessage(target, { text });
    const conversationId = await upsertConversation(ctx.account.id, { externalId: target, name: phoneOf(target) });
    await upsertMessage(conversationId, { externalId: sent!.key.id!, direction: "out", text, sentAt: Date.now(), silent: true });
    return { conversationId };
  },

  async disconnect(ctx) {
    // Unlinks Sangam from the phone (it disappears from WhatsApp → Linked devices).
    const sock = sockets.get(ctx.account.id);
    if (sock?.user) await sock.logout().catch(() => {});
  },
};

/** The sendMessage content for a file: photos/videos show inline, voice notes play, others are documents. */
function mediaContent(f: OutgoingFile, caption: string) {
  if (/^image\/(jpeg|png|webp)$/.test(f.mime)) return { image: f.data, caption, mimetype: f.mime };
  if (f.mime === "video/mp4") return { video: f.data, caption, mimetype: f.mime };
  if (f.mime.startsWith("audio/")) return { audio: f.data, mimetype: f.mime };
  return { document: f.data, mimetype: f.mime, fileName: f.name, caption };
}
