import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const CHANNEL_IDS = ["whatsapp", "telegram", "teams", "gmail", "mail"] as const;
export type ChannelId = (typeof CHANNEL_IDS)[number];

const now = sql`(unixepoch() * 1000)`;

export type MessageButton = { text: string; kind: "callback" | "url" | "unsupported"; url?: string; data?: string };
// mediaLabel: the text is only a stand-in like "📷 Photo" for an attachment with no caption.
// participant: who sent a group message (WhatsApp needs it to mark the message read).
export type MessageExtra = { buttons?: MessageButton[][]; mediaLabel?: boolean; participant?: string };

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  email: text("email").notNull().default(""),
  passwordHash: text("password_hash").notNull(),
  createdAt: integer("created_at").notNull().default(now),
});

export const sessions = sqliteTable("sessions", {
  tokenHash: text("token_hash").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: integer("expires_at").notNull(),
});

// UI preferences and setup state, one JSON value per key.
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const accounts = sqliteTable(
  "accounts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    channel: text("channel").$type<ChannelId>().notNull(),
    externalId: text("external_id").notNull(),
    displayName: text("display_name").notNull(),
    status: text("status").$type<"connected" | "error" | "disconnected" | "demo">().notNull().default("connected"),
    statusMessage: text("status_message"),
    // Encrypted with RELAY_MASTER_KEY; never sent to the browser.
    credentials: text("credentials"),
    syncState: text("sync_state"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [uniqueIndex("accounts_channel_external").on(t.channel, t.externalId)],
);

export const conversations = sqliteTable(
  "conversations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    accountId: integer("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
    channel: text("channel").$type<ChannelId>().notNull(),
    externalId: text("external_id").notNull(),
    name: text("name").notNull(),
    subject: text("subject"),
    unread: integer("unread").notNull().default(0),
    starred: integer("starred", { mode: "boolean" }).notNull().default(false),
    archived: integer("archived", { mode: "boolean" }).notNull().default(false),
    // Hidden locally; deleting in Sangam never deletes anything on the provider.
    hidden: integer("hidden", { mode: "boolean" }).notNull().default(false),
    tags: text("tags", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    lastMessageAt: integer("last_message_at").notNull().default(0),
    // Version tag of the profile photo saved under data/avatars (null = show initials).
    avatar: text("avatar"),
    // Connector-specific state, e.g. who to reply to and which Message-ID to thread under.
    meta: text("meta", { mode: "json" }).$type<Record<string, unknown>>(),
  },
  (t) => [uniqueIndex("conversations_account_external").on(t.accountId, t.externalId), index("conversations_last").on(t.lastMessageAt)],
);

export const messages = sqliteTable(
  "messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    conversationId: integer("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    direction: text("direction").$type<"in" | "out">().notNull(),
    senderName: text("sender_name"),
    text: text("text").notNull().default(""),
    html: text("html"),
    sentAt: integer("sent_at").notNull(),
    status: text("status").$type<"sending" | "sent" | "delivered" | "read" | "failed">().notNull().default("sent"),
    // Channel extras shown with the message, e.g. a Telegram bot's inline buttons.
    extra: text("extra", { mode: "json" }).$type<MessageExtra>(),
    hidden: integer("hidden", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [uniqueIndex("messages_conversation_external").on(t.conversationId, t.externalId), index("messages_conversation_sent").on(t.conversationId, t.sentAt)],
);

/**
 * Files attached to messages. Metadata is recorded during sync; the bytes are fetched from the
 * provider the first time they're opened and cached under data/attachments/<id>.
 */
export const attachments = sqliteTable(
  "attachments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    messageId: integer("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
    // Stable within its message (MIME part id, or "media" for Telegram), so re-syncs don't duplicate.
    key: text("key").notNull(),
    name: text("name").notNull(),
    mime: text("mime").notNull().default("application/octet-stream"),
    size: integer("size"),
    // What the connector needs to download it again (message ids, part ids, folder/uid…).
    ref: text("ref", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    cached: integer("cached", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [uniqueIndex("attachments_message_key").on(t.messageId, t.key)],
);

export const auditLog = sqliteTable("audit_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  at: integer("at").notNull().default(now),
  action: text("action").notNull(),
  detail: text("detail"),
});
