import { withBase } from "./base";
import { AtSign, Mail, MessageCircle, Send, Sparkles, Users } from "lucide-react";

/** "sangam" is the built-in notice chat (account problems and how to fix them), not a service you connect. */
export type ChannelId = "whatsapp" | "telegram" | "teams" | "gmail" | "mail" | "sangam";

export const CHANNELS: { id: ChannelId; name: string; icon: typeof Mail; color: string; bg: string }[] = [
  { id: "whatsapp", name: "WhatsApp", icon: MessageCircle, color: "text-whatsapp", bg: "bg-whatsapp" },
  { id: "telegram", name: "Telegram", icon: Send, color: "text-telegram", bg: "bg-telegram" },
  { id: "teams", name: "Teams", icon: Users, color: "text-teams", bg: "bg-teams" },
  { id: "gmail", name: "Gmail", icon: Mail, color: "text-gmail", bg: "bg-gmail" },
  { id: "mail", name: "Work Mail", icon: AtSign, color: "text-mail", bg: "bg-mail" },
];
const SANGAM_CHANNEL = { id: "sangam" as ChannelId, name: "Sangam", icon: Sparkles, color: "text-primary", bg: "bg-primary" };
// CHANNELS lists services you can connect; the Sangam notice chat is looked up here too.
export const ch = (id: ChannelId) => CHANNELS.find((c) => c.id === id) ?? SANGAM_CHANNEL;

export const BACKGROUNDS = [
  { id: "default", name: "Cream", light: "oklch(0.975 0.006 85)", dark: "oklch(0.16 0.02 260)" },
  { id: "paper", name: "Paper", light: "oklch(0.99 0.002 85)", dark: "oklch(0.13 0.015 260)" },
  { id: "sage", name: "Sage", light: "oklch(0.955 0.02 140)", dark: "oklch(0.17 0.025 180)" },
  { id: "rose", name: "Rose", light: "oklch(0.96 0.015 20)", dark: "oklch(0.17 0.02 340)" },
] as const;
export type BackgroundId = (typeof BACKGROUNDS)[number]["id"];

export type User = { id: number; name: string; email: string };

export type Account = {
  id: number;
  channel: ChannelId;
  displayName: string;
  status: "connected" | "error" | "disconnected" | "demo";
  statusMessage: string | null;
};

export type Conversation = {
  id: number;
  accountId: number;
  channel: ChannelId;
  /** The provider's id for this chat (Telegram peer id, Gmail thread id, root Message-ID). */
  externalId: string;
  name: string;
  subject: string | null;
  unread: number;
  starred: boolean;
  archived: boolean;
  tags: string[];
  /** null = Inbox, "spam" = Spam, else one of your folders. */
  folder: string | null;
  lastMessageAt: number;
  /** Profile photo version; null shows initials. */
  avatar: string | null;
  lastMessage: { direction: "in" | "out"; text: string; sentAt: number } | null;
  /** Saved contact this chat belongs to (Sangam's address book). */
  contactId: number | null;
  contactName: string | null;
  /** The name the service itself uses (shown as a subtitle when a contact name replaces it). */
  serviceName?: string;
  /** The other person's phone / email, when known. */
  handle: { phone: string | null; email: string | null };
  /** A Telegram broadcast channel (a feed). */
  broadcast?: boolean;
  /** You can't post here (a channel you don't admin). */
  readOnly?: boolean;
};

export type Contact = { id: number; name: string; phone: string | null; email: string | null; notes: string; conversationIds: number[] };

export type Message = {
  id: number;
  conversationId: number;
  direction: "in" | "out";
  senderName: string | null;
  text: string;
  /** Original email HTML; rendered only inside the sandboxed EmailFrame. */
  html: string | null;
  /** Bot buttons under the message (callback data stays on the server). */
  extra: { buttons?: MessageButton[][]; mediaLabel?: boolean } | null;
  attachments: Attachment[];
  sentAt: number;
  status: "sending" | "sent" | "delivered" | "read" | "failed";
};

export type Attachment = {
  id: number;
  name: string;
  mime: string;
  size: number | null;
  /** Has a small preview image (photo thumbnail / video poster) at /api/attachments/:id/thumb. */
  thumb?: boolean;
  /** Videos can play while streaming, at any size. */
  stream?: boolean;
  /** Video length in seconds, when known. */
  duration?: number | null;
};

export type GroupMember = { id: string; name: string; handle: string | null; role: "owner" | "admin" | "member"; you: boolean };
export type GroupMembers = { total: number; members: GroupMember[]; note?: string };

export type MessageButton = { text: string; kind: "callback" | "url" | "unsupported"; url?: string };
export type BotCommand = { command: string; description: string };
export type BotInfo = { commands: BotCommand[]; keyboard: string[][] | null };

export type Settings = {
  dark: boolean;
  bg: BackgroundId;
  collapsed: boolean;
  channels: ChannelId[];
  setupDone: boolean;
  /** Load remote images in every email (they can tell the sender you opened it). */
  autoLoadImages: boolean;
  /** Domains whose emails always load images, e.g. "flipkart.com" (subdomains included). */
  trustedImageDomains: string[];
  /** Added to the end of messages you write; may contain simple HTML like <small>. */
  signature: string;
  /** Apps whose messages get the signature (all by default). */
  signatureChannels: ChannelId[];
  /** System notifications when Sangam isn't the window you're looking at (needs the browser's permission). */
  notifyDesktop: boolean;
  notifySound: boolean;
  /** Apps whose new messages notify (all by default). */
  notifyChannels: ChannelId[];
  /** Chats that never notify (their unread count still goes up). */
  mutedChats: number[];
  /** Your folders, in sidebar order (chats point at them by name). */
  folders: string[];
  /** Move likely spam from new senders into Spam automatically. */
  spamFilter: boolean;
  /** Tags on number keys 1–9; empty = your most-used tags. */
  quickTags: string[];
  /** Ask for the Sangam password after this many idle minutes (and on "Lock now"). */
  appLock: boolean;
  appLockMinutes: number;
  /** Names, previews and messages stay blurred until hovered. */
  blurChats: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  dark: false,
  bg: "default",
  collapsed: false,
  channels: CHANNELS.map((c) => c.id),
  setupDone: false,
  autoLoadImages: false,
  trustedImageDomains: [],
  signature: "",
  signatureChannels: CHANNELS.map((c) => c.id),
  notifyDesktop: false,
  notifySound: true,
  notifyChannels: CHANNELS.map((c) => c.id),
  mutedChats: [],
  folders: [],
  spamFilter: true,
  quickTags: [],
  appLock: false,
  appLockMinutes: 5,
  blurChats: false,
};

/** Fired when the server says this session is locked (423), so the page swaps to the lock screen. */
export const LOCKED_EVENT = "sangam:locked";
const signalLocked = (status: number) => { if (status === 423) window.dispatchEvent(new Event(LOCKED_EVENT)); };

export const SPAM_FOLDER = "spam";

/** The domain of an email address, lowercased ("Offers <x@Mail.Flipkart.com>" → "mail.flipkart.com"). */
export const emailDomain = (address: string | null | undefined) => address?.match(/@([\w.-]+)/)?.[1]?.toLowerCase().replace(/\.$/, "") ?? null;

/** The main domain to trust: "rmp.flipkart.com" → "flipkart.com", "mail.irctc.co.in" → "irctc.co.in". */
export function baseDomain(domain: string) {
  const parts = domain.split(".");
  // Country domains like co.in, com.au, ac.uk take one more label.
  const keep = parts.length > 2 && /^(co|com|net|org|gov|ac|edu|nic|res|ltd|plc)$/.test(parts.at(-2)!) && parts.at(-1)!.length === 2 ? 3 : 2;
  return parts.slice(-keep).join(".");
}

/** The trusted entry covering this domain, if any ("flipkart.com" covers "mail.flipkart.com"). */
export const trustedDomainFor = (domain: string | null, trusted: string[]) =>
  domain ? (trusted.find((d) => domain === d || domain.endsWith(`.${d}`)) ?? null) : null;

export function formatTime(ms: number) {
  if (!ms) return "";
  const d = new Date(ms);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { day: "numeric", month: "short" });
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Multipart upload (message text + files); same error handling as api(). */
export async function apiForm<T>(path: string, form: FormData): Promise<T> {
  const res = await fetch(withBase(`/api${path}`), { method: "POST", credentials: "same-origin", body: form });
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  signalLocked(res.status);
  if (!res.ok) throw new ApiError(data?.error ?? `Upload failed (${res.status})`, res.status);
  return data as T;
}

export async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = options.method ?? "GET";
  const res = await fetch(withBase(`/api${path}`), {
    method,
    credentials: "same-origin",
    // Every write is JSON: the backend's CSRF guard rejects form-style posts.
    ...(method !== "GET" && { headers: { "content-type": "application/json" }, body: JSON.stringify(options.body ?? {}) }),
  });
  const data = (await res.json().catch(() => null)) as { error?: string; issues?: { message: string }[] } | null;
  // Validation errors carry the specific, human-readable reason in their first issue.
  signalLocked(res.status);
  if (!res.ok) throw new ApiError(data?.issues?.[0]?.message ?? data?.error ?? `Request failed (${res.status})`, res.status);
  return data as T;
}
