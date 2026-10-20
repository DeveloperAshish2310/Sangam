import type { ChannelId, MessageButton } from "../db/schema";
import type { schema } from "../db";
import type { IncomingMessage } from "../store";

export type Account = typeof schema.accounts.$inferSelect;
export type Conversation = typeof schema.conversations.$inferSelect;

/** Everything a connector may touch. Credentials are decrypted only here, on the server. */
export interface ConnectorContext {
  account: Account;
  getCredentials<T>(): T | null;
  saveCredentials(value: unknown): Promise<void>;
  getSyncState<T>(): T | null;
  saveSyncState(value: unknown): Promise<void>;
  setStatus(status: Account["status"], message?: string): Promise<void>;
  log(...args: unknown[]): void;
}

/**
 * One adapter per channel. Connecting (OAuth, phone code, QR scan) is channel-specific
 * and handled by that channel's routes; once an account exists, the registry drives it
 * through this interface.
 */
export interface Connector {
  channel: ChannelId;
  /** Backfill and begin listening (persistent connection or polling). Returns a stop function. */
  start(ctx: ConnectorContext): Promise<() => void | Promise<void>>;
  /** Sends text and/or files. Telegram sends one message per file, hence the optional array. */
  send(ctx: ConnectorContext, conversation: Conversation, text: string, files: OutgoingFile[]): Promise<IncomingMessage | IncomingMessage[]>;
  /** Fetches an attachment's bytes from the provider (cached by the caller afterwards). */
  downloadAttachment?(ctx: ConnectorContext, conversation: Conversation, attachment: { key: string; name: string; ref: Record<string, unknown> }): Promise<Buffer>;
  markRead?(ctx: ConnectorContext, conversation: Conversation): Promise<void>;
  /** Revoke tokens / log out on the provider side. */
  disconnect?(ctx: ConnectorContext): Promise<void>;
  /** Press an interactive button attached to a message (e.g. a Telegram bot's inline button). */
  pressButton?(ctx: ConnectorContext, conversation: Conversation, messageExternalId: string, button: MessageButton): Promise<ButtonResult>;
  /** Bot extras for a conversation: commands for "/" suggestions and the bot's reply keyboard. */
  botInfo?(ctx: ConnectorContext, conversation: Conversation): Promise<BotInfo>;
  /** Start a brand-new conversation (new email / first message to someone). Stores it and returns its id. */
  compose?(ctx: ConnectorContext, input: ComposeInput): Promise<{ conversationId: number }>;
  /** Delete messages on the provider (Telegram delete, email → Trash). */
  deleteMessages?(ctx: ConnectorContext, conversation: Conversation, externalIds: string[], opts: DeleteOptions): Promise<void>;
  /**
   * Delete the whole conversation on the provider. keepChat = "clear history" (Telegram keeps the
   * empty chat); otherwise the chat goes away (for a Telegram group that means leaving it).
   */
  deleteConversation?(ctx: ConnectorContext, conversation: Conversation, opts: DeleteOptions & { keepChat: boolean }): Promise<void>;
}

/** forEveryone: also delete for the other side, where the provider supports it (Telegram). */
export type DeleteOptions = { forEveryone: boolean };

export type ComposeInput = { to: string; subject?: string | undefined; text: string };

export type OutgoingFile = { name: string; mime: string; data: Buffer };

export type ButtonResult = { answer?: string | undefined; url?: string | undefined };
export type BotCommand = { command: string; description: string };
export type BotInfo = { commands: BotCommand[]; keyboard: string[][] | null };
