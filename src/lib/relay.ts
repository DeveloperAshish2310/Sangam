import { AtSign, Mail, MessageCircle, Send, Users } from "lucide-react";

export type ChannelId = "whatsapp" | "telegram" | "teams" | "gmail" | "mail";

export const CHANNELS: { id: ChannelId; name: string; icon: typeof Mail; color: string; bg: string }[] = [
  { id: "whatsapp", name: "WhatsApp", icon: MessageCircle, color: "text-whatsapp", bg: "bg-whatsapp" },
  { id: "telegram", name: "Telegram", icon: Send, color: "text-telegram", bg: "bg-telegram" },
  { id: "teams", name: "Teams", icon: Users, color: "text-teams", bg: "bg-teams" },
  { id: "gmail", name: "Gmail", icon: Mail, color: "text-gmail", bg: "bg-gmail" },
  { id: "mail", name: "Work Mail", icon: AtSign, color: "text-mail", bg: "bg-mail" },
];
export const ch = (id: ChannelId) => CHANNELS.find((c) => c.id === id)!;

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
  lastMessageAt: number;
  /** Profile photo version; null shows initials. */
  avatar: string | null;
  lastMessage: { direction: "in" | "out"; text: string; sentAt: number } | null;
};

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

export type Attachment = { id: number; name: string; mime: string; size: number | null };

export type MessageButton = { text: string; kind: "callback" | "url" | "unsupported"; url?: string };
export type BotCommand = { command: string; description: string };
export type BotInfo = { commands: BotCommand[]; keyboard: string[][] | null };

export type Settings = {
  dark: boolean;
  bg: BackgroundId;
  collapsed: boolean;
  channels: ChannelId[];
  setupDone: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  dark: false,
  bg: "default",
  collapsed: false,
  channels: CHANNELS.map((c) => c.id),
  setupDone: false,
};

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
  const res = await fetch(`/api${path}`, { method: "POST", credentials: "same-origin", body: form });
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new ApiError(data?.error ?? `Upload failed (${res.status})`, res.status);
  return data as T;
}

export async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = options.method ?? "GET";
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    // Every write is JSON: the backend's CSRF guard rejects form-style posts.
    ...(method !== "GET" && { headers: { "content-type": "application/json" }, body: JSON.stringify(options.body ?? {}) }),
  });
  const data = (await res.json().catch(() => null)) as { error?: string; issues?: { message: string }[] } | null;
  // Validation errors carry the specific, human-readable reason in their first issue.
  if (!res.ok) throw new ApiError(data?.issues?.[0]?.message ?? data?.error ?? `Request failed (${res.status})`, res.status);
  return data as T;
}
