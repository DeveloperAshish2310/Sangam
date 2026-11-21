import { motion } from "motion/react";
import { Backdrop, dialogMotion } from "./motion";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Ban, BellRing, Check, Crown, Download, FileText, Link2, Loader2, Play, Search, Shield, Users, Video, UserRound, Clock, Database, Image as ImageIcon, Lock, LogOut, Moon, RotateCcw, Settings, ShieldCheck, Star, Sun, Tag, Trash2, X } from "lucide-react";
import { BACKGROUNDS, ch, CHANNELS, type Account, type Attachment, type ChannelId, type Conversation, type Settings as RelaySettings, type User } from "@/lib/relay";
import { Avatar, avatarUrl, initials, SectionLabel, SlideOver } from "./common";
import { attachmentUrl, formatSize, Lightbox, thumbUrl } from "./Attachments";
import { useChatMedia, useGroupMembers } from "@/hooks/use-relay";
import { installApp, useInstallState } from "@/lib/pwa";
import { withBase } from "@/lib/base";
import { desktopPermission, desktopSupported, requestDesktop } from "@/lib/notify";

const STATUS_BADGE: Record<Account["status"], { label: string; className: string }> = {
  connected: { label: "Live", className: "text-whatsapp" },
  demo: { label: "Demo", className: "text-muted-foreground" },
  error: { label: "Error", className: "text-destructive" },
  disconnected: { label: "Off", className: "text-muted-foreground" },
};

export type Connectors = Partial<Record<ChannelId, { available: boolean; hint?: string; form?: boolean }>>;

export function ProfilePanel({ user, accounts, convos, connectors, onConnectForm, onDisconnect, onClose, onSettings, onSignOut }: {
  user: User; accounts: Account[]; convos: Conversation[]; connectors: Connectors;
  onConnectForm: (channel: ChannelId, account?: Account) => void; onDisconnect: (a: Account) => void;
  onClose: () => void; onSettings: () => void; onSignOut: () => void;
}) {
  return (
    <SlideOver title="Profile" onClose={onClose}>
      <div className="mt-6 flex flex-col items-center text-center">
        <div className="grid h-20 w-20 place-items-center rounded-full bg-secondary font-display text-2xl font-semibold text-secondary-foreground">{initials(user.name)}</div>
        <p className="mt-3 text-lg font-semibold">{user.name}</p>
        {user.email && <p className="text-sm text-muted-foreground">{user.email}</p>}
      </div>

      <div className="mt-6 grid grid-cols-3 gap-2">
        {[
          { label: "Chats", value: convos.length },
          { label: "Unread", value: convos.filter((c) => !c.archived).reduce((n, c) => n + c.unread, 0) },
          { label: "Accounts", value: accounts.length },
        ].map((s) => (
          <div key={s.label} className="rounded-xl border bg-card p-3 text-center">
            <p className="font-display text-xl font-semibold">{s.value}</p>
            <p className="text-[11px] text-muted-foreground">{s.label}</p>
          </div>
        ))}
      </div>

      <SectionLabel className="mt-8">Accounts</SectionLabel>
      <div className="mt-2 space-y-2">
        {CHANNELS.map((c) => {
          const real = accounts.filter((a) => a.channel === c.id && a.status !== "demo");
          const demo = accounts.find((a) => a.channel === c.id && a.status === "demo");
          const connector = connectors[c.id];
          const connectHref = withBase(`/api/connect/${c.id}/start`);
          return (
            <div key={c.id} className="rounded-xl border bg-card p-3">
              <div className="flex items-center gap-3">
                <span className={`grid h-9 w-9 place-items-center rounded-lg ${c.bg}`}><c.icon className="h-4 w-4 text-primary-foreground" /></span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{c.name}</p>
                  {!real.length && (
                    <p className="truncate text-xs text-muted-foreground">
                      {connector && !connector.available ? connector.hint : demo ? "Showing demo data" : "Not connected"}
                    </p>
                  )}
                </div>
                {connector?.available ? (
                  <ConnectLink href={connectHref} form={connector.form} onForm={() => onConnectForm(c.id)}
                    className="rounded-lg bg-primary px-2.5 py-1 text-[11px] font-semibold text-primary-foreground transition hover:opacity-90">
                    {real.length ? "Add" : "Connect"}
                  </ConnectLink>
                ) : (
                  !real.length && (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground" title={connector ? connector.hint : "Arrives in a later phase"}>
                      {connector ? "Setup needed" : "Soon"}
                    </span>
                  )
                )}
              </div>
              {real.map((account) => {
                const badge = STATUS_BADGE[account.status];
                const cc = convos.filter((v) => v.accountId === account.id);
                return (
                  <div key={account.id} className="mt-2.5 border-t pt-2.5">
                    <div className="flex items-center gap-2">
                      <p className="min-w-0 flex-1 truncate text-xs font-medium">{account.displayName}</p>
                      <span className={`flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-[10px] font-semibold ${badge.className}`}>
                        {account.status === "connected" && <Check className="h-3 w-3" />} {badge.label}
                      </span>
                    </div>
                    {account.statusMessage && <p className={`mt-1 text-[11px] ${account.status === "error" ? "text-destructive" : "text-muted-foreground"}`}>{account.statusMessage}</p>}
                    <div className="mt-1.5 flex items-center gap-4 text-[11px] text-muted-foreground">
                      <span><span className="font-semibold text-foreground">{cc.length}</span> chats</span>
                      <span><span className="font-semibold text-foreground">{cc.reduce((n, v) => n + v.unread, 0)}</span> unread</span>
                      <span className="ml-auto flex gap-3">
                        {account.status === "error" && (
                          <ConnectLink href={connectHref} form={connector?.form} onForm={() => onConnectForm(c.id, account)} className="font-semibold text-primary hover:underline">
                            Reconnect
                          </ConnectLink>
                        )}
                        <button onClick={() => onDisconnect(account)} className="font-semibold text-destructive hover:underline">Disconnect</button>
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      <SectionLabel>Account</SectionLabel>
      <div className="mt-2 space-y-1">
        <button onClick={onSettings} className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm font-medium transition hover:bg-muted">
          <Settings className="h-4 w-4" /> Open settings
        </button>
        <button onClick={onSignOut} className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm font-medium text-destructive transition hover:bg-muted">
          <LogOut className="h-4 w-4" /> Sign out
        </button>
      </div>
    </SlideOver>
  );
}

/** OAuth channels navigate to the provider; password-based channels open a form instead. */
function ConnectLink({ href, form, onForm, className, children }: { href: string; form: boolean | undefined; onForm: () => void; className: string; children: ReactNode }) {
  return form ? <button onClick={onForm} className={className}>{children}</button> : <a href={href} className={className}>{children}</a>;
}

export function ContactPanel({ convo, account, onClose, onClear, onDelete, onRemoveTag, onSaveContact }: {
  convo: Conversation; account: Account | undefined; onClose: () => void; onClear: () => void; onDelete: () => void; onRemoveTag: (tag: string) => void;
  /** Opens the contact dialog: edit when the chat already has a saved contact, else save a new one. */
  onSaveContact: () => void;
}) {
  const C = ch(convo.channel);
  return (
    <SlideOver title="Contact info" onClose={onClose} closeLeft>
      <div className="mt-6 flex flex-col items-center text-center">
        <Avatar name={convo.name} channel={convo.channel} big photo={avatarUrl(convo)} />
        <p className="mt-3 text-lg font-semibold">{convo.name}</p>
        {convo.subject && <p className="text-sm text-muted-foreground">{convo.subject}</p>}
        <span className={`mt-2 flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium text-primary-foreground ${C.bg}`}>
          <C.icon className="h-3 w-3" /> via {C.name}
        </span>
      </div>

      <div className="mt-6 flex items-center gap-3 rounded-xl border bg-card p-4">
        <UserRound className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{convo.contactId ? "Saved contact" : "Not in your contacts"}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {[convo.handle.phone && `+${convo.handle.phone}`, convo.handle.email, convo.serviceName && `shown by ${C.name} as “${convo.serviceName}”`].filter(Boolean).join(" · ") || "Save to give this chat a name you choose"}
          </span>
        </span>
        <button onClick={onSaveContact} className="shrink-0 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90">
          {convo.contactId ? "Edit" : "Save contact"}
        </button>
      </div>

      <div className="mt-4 rounded-xl border bg-card p-4">
        <SectionLabel className="">Your account</SectionLabel>
        <p className="mt-1 text-sm">{account ? (account.status === "demo" ? "Demo data" : account.displayName) : "—"}</p>
        {convo.tags.length > 0 && (
          <>
            <SectionLabel className="mt-3">Tags</SectionLabel>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {convo.tags.map((t) => (
                <span key={t} className="flex items-center gap-1 rounded-full bg-muted py-0.5 pl-2 pr-1 text-xs font-medium">
                  <Tag className="h-2.5 w-2.5" />{t}
                  <button onClick={() => onRemoveTag(t)} title={`Remove tag “${t}”`} className="grid h-4 w-4 place-items-center rounded-full text-muted-foreground hover:bg-destructive/15 hover:text-destructive">
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          </>
        )}
      </div>

      {mayBeGroup(convo) && <GroupMembersCard convo={convo} />}

      <ChatMedia convoId={convo.id} />

      <div className="mt-4 divide-y rounded-xl border bg-card">
        {[
          { icon: Star, label: "Starred", sub: convo.starred ? "Starred chat" : "Not starred" },
          { icon: Clock, label: "Disappearing messages", sub: `Managed in ${C.name}` },
          { icon: ShieldCheck, label: "Stored locally", sub: "Messages are kept in Sangam's database on this PC." },
          { icon: Lock, label: "Credentials", sub: "Account tokens are encrypted with your master key." },
        ].map((r) => (
          <div key={r.label} className="flex w-full items-center gap-3 px-4 py-3 text-left">
            <r.icon className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0">
              <span className="block text-sm font-medium">{r.label}</span>
              <span className="block truncate text-xs text-muted-foreground">{r.sub}</span>
            </span>
          </div>
        ))}
      </div>

      <div className="mt-4 divide-y rounded-xl border bg-card">
        <button onClick={onClear} className="flex w-full items-center gap-3 px-4 py-3 text-sm font-medium text-destructive transition hover:bg-muted/60">
          <Ban className="h-4 w-4" /> Clear chat
        </button>
        <button onClick={onDelete} className="flex w-full items-center gap-3 px-4 py-3 text-sm font-medium text-destructive transition hover:bg-muted/60">
          <Trash2 className="h-4 w-4" /> Delete chat
        </button>
      </div>
      <p className="mt-2 px-1 text-[11px] text-muted-foreground">You'll be asked whether to delete it in {C.name} too.</p>
    </SlideOver>
  );
}

/** Chats that can have members: WhatsApp groups, and Telegram groups/channels (negative peer ids). */
const mayBeGroup = (c: Conversation) =>
  (c.channel === "whatsapp" && c.externalId.endsWith("@g.us")) || (c.channel === "telegram" && c.externalId.startsWith("-"));

const ROLE_ORDER = { owner: 0, admin: 1, member: 2 } as const;
const MEMBERS_SHOWN = 30;

/** Group info → members: owner and admins first, then everyone by name; searchable in big groups. */
function GroupMembersCard({ convo }: { convo: Conversation }) {
  const { data, isLoading, error } = useGroupMembers(convo.id, true);
  const [query, setQuery] = useState("");
  const [all, setAll] = useState(false);
  const sorted = useMemo(
    () => [...(data?.members ?? [])].sort((a, b) => Number(b.you) - Number(a.you) || ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.name.localeCompare(b.name)),
    [data],
  );
  const q = query.trim().toLowerCase();
  const matches = q ? sorted.filter((m) => `${m.name} ${m.handle ?? ""}`.toLowerCase().includes(q)) : sorted;
  const shown = all || q ? matches : matches.slice(0, MEMBERS_SHOWN);
  if (!isLoading && !error && !data) return null;
  return (
    <div className="mt-4 rounded-xl border bg-card">
      <div className="flex items-center gap-2 px-4 pt-3">
        <Users className="h-4 w-4 text-muted-foreground" />
        <span className="flex-1 text-sm font-medium">{data ? `${data.total.toLocaleString()} ${convo.broadcast ? "subscribers" : "members"}` : "Members"}</span>
      </div>
      {isLoading ? (
        <p className="flex items-center gap-2 px-4 py-4 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading members…</p>
      ) : error ? (
        <p className="px-4 py-3 text-xs text-destructive">Couldn't load members: {error instanceof Error ? error.message : String(error)}</p>
      ) : data!.note ? (
        <p className="px-4 py-3 text-xs text-muted-foreground">{data!.note}</p>
      ) : (
        <>
          {sorted.length > 10 && (
            <label className="mx-3 mt-2 flex items-center gap-2 rounded-lg border bg-background px-2.5 py-1.5">
              <Search className="h-3.5 w-3.5 text-muted-foreground" />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search members" className="w-full bg-transparent text-sm outline-none" />
            </label>
          )}
          <ul className="mt-1 max-h-96 overflow-y-auto px-1.5 pb-1.5 scrollbar-thin">
            {shown.map((m) => (
              <li key={m.id} className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5">
                <Avatar name={m.name} channel={convo.channel} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{m.name}{m.you && m.name !== "You" && <span className="text-muted-foreground"> (you)</span>}</span>
                  {m.handle && m.handle !== m.name && <span className="block truncate text-[11px] text-muted-foreground">{m.handle}</span>}
                </span>
                {m.role !== "member" && (
                  <span className="flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
                    {m.role === "owner" ? <Crown className="h-2.5 w-2.5" /> : <Shield className="h-2.5 w-2.5" />}
                    {m.role === "owner" ? "Owner" : "Admin"}
                  </span>
                )}
              </li>
            ))}
            {!shown.length && <li className="px-2.5 py-3 text-xs text-muted-foreground">No member matches “{query}”</li>}
          </ul>
          {!all && !q && matches.length > MEMBERS_SHOWN && (
            <button onClick={() => setAll(true)} className="w-full border-t px-4 py-2 text-xs font-medium text-primary hover:bg-muted/60">
              Show all {matches.length.toLocaleString()}
            </button>
          )}
          {data!.total > sorted.length && (
            <p className="border-t px-4 py-2 text-[11px] text-muted-foreground">Showing {sorted.length.toLocaleString()} of {data!.total.toLocaleString()}. Open the group in {ch(convo.channel).name} for the full list.</p>
          )}
        </>
      )}
    </div>
  );
}

const PAGE = 24;

/** Contact info → Media, Docs and Links from this chat (newest first). Images open in the viewer. */
function ChatMedia({ convoId }: { convoId: number }) {
  const { data, isLoading } = useChatMedia(convoId);
  const [tab, setTab] = useState<"media" | "docs" | "links">("media");
  const [limit, setLimit] = useState(PAGE);
  const [viewing, setViewing] = useState<Attachment | null>(null);
  useEffect(() => setLimit(PAGE), [tab, convoId]);
  const counts = { media: data?.media.length ?? 0, docs: data?.docs.length ?? 0, links: data?.links.length ?? 0 };
  const items = data?.[tab] ?? [];
  const more = items.length > limit;
  const date = (ms: number) => new Date(ms).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });

  return (
    <div className="mt-4 rounded-xl border bg-card">
      <div className="flex items-center gap-2 px-4 pt-3 text-sm font-medium"><ImageIcon className="h-4 w-4 text-muted-foreground" /> Media, links and docs</div>
      <div className="mt-2 flex gap-1 border-b px-3">
        {(["media", "docs", "links"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-2 pb-2 text-xs font-medium capitalize transition ${tab === t ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
            {t} <span className="text-muted-foreground">{counts[t]}</span>
          </button>
        ))}
      </div>
      <div className="p-3">
        {isLoading ? (
          <div className="grid grid-cols-3 gap-1.5">{Array.from({ length: 6 }, (_, i) => <div key={i} className="aspect-square animate-pulse rounded-lg bg-muted" />)}</div>
        ) : !items.length ? (
          <p className="py-4 text-center text-xs text-muted-foreground">No {tab} in this chat{tab === "links" ? "" : " yet"}</p>
        ) : tab === "media" ? (
          <div className="grid grid-cols-3 gap-1.5">
            {data!.media.slice(0, limit).map((m) =>
              m.mime.startsWith("image/") ? (
                <button key={m.id} onClick={() => setViewing({ id: m.id, name: m.name, mime: m.mime, size: m.size })} title={`${m.name} · ${date(m.sentAt)}`}
                  className="aspect-square overflow-hidden rounded-lg bg-muted transition hover:opacity-85">
                  <img src={m.thumb ? thumbUrl(m) : attachmentUrl(m)} alt={m.name} loading="lazy" className="h-full w-full object-cover"
                    onError={(e) => { e.currentTarget.style.display = "none"; }} />
                </button>
              ) : (
                <a key={m.id} href={attachmentUrl(m)} target="_blank" rel="noreferrer" title={`${m.name} · ${date(m.sentAt)}`}
                  className="relative grid aspect-square place-items-center overflow-hidden rounded-lg bg-muted text-muted-foreground transition hover:opacity-85">
                  {m.thumb ? (
                    <>
                      <img src={thumbUrl(m)} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" onError={(e) => { e.currentTarget.style.display = "none"; }} />
                      <span className="relative grid h-8 w-8 place-items-center rounded-full bg-black/55 text-white"><Play className="ml-0.5 h-4 w-4 fill-current" /></span>
                    </>
                  ) : (
                    <Video className="h-6 w-6" />
                  )}
                </a>
              ),
            )}
          </div>
        ) : tab === "docs" ? (
          <div className="space-y-1">
            {data!.docs.slice(0, limit).map((d) => (
              <a key={d.id} href={attachmentUrl(d, true)} download={d.name} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition hover:bg-muted">
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{d.name}</span>
                  <span className="block text-[11px] text-muted-foreground">{[formatSize(d.size), date(d.sentAt)].filter(Boolean).join(" · ")}</span>
                </span>
                <Download className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              </a>
            ))}
          </div>
        ) : (
          <div className="space-y-1">
            {data!.links.slice(0, limit).map((l) => (
              <a key={l.url} href={l.url} target="_blank" rel="noreferrer noopener" className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition hover:bg-muted">
                <Link2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{l.url.replace(/^https?:\/\/(www\.)?/, "")}</span>
                  <span className="block text-[11px] text-muted-foreground">{date(l.sentAt)}</span>
                </span>
              </a>
            ))}
          </div>
        )}
        {more && (
          <button onClick={() => setLimit((n) => n + PAGE * 2)} className="mt-2 w-full rounded-lg py-1.5 text-xs font-medium text-primary hover:bg-muted">
            Show more ({items.length - limit})
          </button>
        )}
      </div>
      <Lightbox attachment={viewing} onClose={() => setViewing(null)} />
    </div>
  );
}

/** Install Sangam as its own app (window, taskbar icon with unread badge). */
function InstallCard() {
  const state = useInstallState();
  return (
    <div className="mt-2 flex items-center gap-3 rounded-xl border p-3">
      <img src={withBase("icons/icon-192.png")} alt="" className="h-10 w-10 shrink-0 rounded-xl" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{state === "installed" ? "Sangam app is installed" : "Install Sangam app"}</p>
        <p className="text-xs text-muted-foreground">
          {state === "installed"
            ? "Opens in its own window, with unread count on its icon"
            : state === "available"
              ? "Its own window, taskbar icon and unread badge"
              : "Use your browser menu → \"Install Sangam\" (or Share → Add to Home Screen on iPhone)"}
        </p>
      </div>
      {state === "available" && (
        <button onClick={() => void installApp()} className="shrink-0 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90">
          Install
        </button>
      )}
      {state === "installed" && <Check className="h-4 w-4 shrink-0 text-primary" />}
    </div>
  );
}

export function SettingsPanel({ settings, update, allTags, onLockNow, hasDemo, onDemo, onRerunSetup, onSignOut, onTestNotification, onClose }: {
  settings: RelaySettings; update: (patch: Partial<RelaySettings>) => void; allTags: string[]; onLockNow: () => void; hasDemo: boolean;
  onDemo: (load: boolean) => void; onRerunSetup: () => void; onSignOut: () => void; onTestNotification: () => void; onClose: () => void;
}) {
  return (
    <SlideOver title="Settings" width="w-80" onClose={onClose}>
      <SectionLabel>Theme</SectionLabel>
      <ThemePicker settings={settings} update={update} />

      <SectionLabel>Sidebar</SectionLabel>
      <button onClick={() => update({ collapsed: !settings.collapsed })}
        className="mt-2 flex w-full items-center justify-between rounded-xl border px-3 py-2.5 text-sm font-medium hover:bg-muted">
        Collapse sidebar
        <span className={`h-5 w-9 rounded-full p-0.5 transition ${settings.collapsed ? "bg-primary" : "bg-muted"}`}>
          <span className={`block h-4 w-4 rounded-full bg-card shadow transition ${settings.collapsed ? "translate-x-4" : ""}`} />
        </span>
      </button>

      <SectionLabel>App</SectionLabel>
      <InstallCard />

      <SectionLabel>Privacy</SectionLabel>
      <div className="mt-2 rounded-xl border p-3">
        <Toggle on={settings.appLock} label="App lock" hint="Asks for your Sangam password after you've been away, like WhatsApp's app lock"
          onClick={() => update({ appLock: !settings.appLock })} />
        {settings.appLock && (
          <div className="mt-1 space-y-2 px-1.5 pb-1">
            <label className="flex items-center justify-between gap-2 text-sm">
              Lock after
              <select value={settings.appLockMinutes} onChange={(e) => update({ appLockMinutes: Number(e.target.value) })}
                className="rounded-lg border bg-card px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-ring">
                {[1, 5, 15, 30, 60].map((m) => <option key={m} value={m}>{m === 60 ? "1 hour" : `${m} minute${m > 1 ? "s" : ""}`} idle</option>)}
              </select>
            </label>
            <button onClick={onLockNow} className="flex w-full items-center justify-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-medium hover:bg-muted">
              <Lock className="h-3.5 w-3.5" /> Lock now <kbd className="rounded border px-1 text-[10px] text-muted-foreground">Ctrl+Shift+L</kbd>
            </button>
          </div>
        )}
        <Toggle on={settings.blurChats} label="Blur chats" hint="Names, previews and messages stay blurred until you hover over them"
          onClick={() => update({ blurChats: !settings.blurChats })} />
      </div>

      <SectionLabel>Notifications</SectionLabel>
      <NotificationSettings settings={settings} update={update} onTest={onTestNotification} />

      <SectionLabel>Quick tags</SectionLabel>
      <QuickTagSettings settings={settings} update={update} allTags={allTags} />

      <SectionLabel>Spam</SectionLabel>
      <div className="mt-2 rounded-xl border p-3">
        <Toggle on={settings.spamFilter} label="Spam filter" hint="New senders whose messages look like scams go to Spam. Contacts and people you've replied to never do."
          onClick={() => update({ spamFilter: !settings.spamFilter })} />
        <p className="mt-1 px-1.5 text-[11px] text-muted-foreground">Mark or unmark with right-click → Mark as spam, or press <kbd className="rounded border px-1">!</kbd>. Sangam remembers the sender.</p>
      </div>

      <SectionLabel>Signature</SectionLabel>
      <SignatureSettings settings={settings} update={update} />

      <SectionLabel>Email images</SectionLabel>
      <button onClick={() => update({ autoLoadImages: !settings.autoLoadImages })} aria-pressed={settings.autoLoadImages}
        className="mt-2 flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-2.5 text-left text-sm font-medium hover:bg-muted">
        <span>
          Always load images
          <span className="block text-[11px] font-normal text-muted-foreground">Senders can see when you open their email</span>
        </span>
        <span className={`h-5 w-9 shrink-0 rounded-full p-0.5 transition ${settings.autoLoadImages ? "bg-primary" : "bg-muted"}`}>
          <span className={`block h-4 w-4 rounded-full bg-card shadow transition ${settings.autoLoadImages ? "translate-x-4" : ""}`} />
        </span>
      </button>
      {!settings.autoLoadImages && (
        <div className="mt-2 rounded-xl border px-3 py-2.5">
          <p className="text-[11px] text-muted-foreground">
            {settings.trustedImageDomains.length ? "Always load images from:" : "No trusted senders yet. In an email, use Load images ▾ → Always load images from…"}
          </p>
          {settings.trustedImageDomains.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {settings.trustedImageDomains.map((d) => (
                <span key={d} className="flex items-center gap-1 rounded-full bg-muted py-0.5 pl-2.5 pr-1 text-xs">
                  {d}
                  <button onClick={() => update({ trustedImageDomains: settings.trustedImageDomains.filter((x) => x !== d) })} title={`Stop loading images from ${d}`}
                    className="grid h-4 w-4 place-items-center rounded-full hover:bg-destructive/15 hover:text-destructive"><X className="h-3 w-3" /></button>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      <SectionLabel>Data</SectionLabel>
      <div className="mt-2 space-y-1">
        <button onClick={() => onDemo(!hasDemo)} className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm font-medium transition hover:bg-muted">
          <Database className="h-4 w-4" /> {hasDemo ? "Remove demo data" : "Load demo data"}
        </button>
        <button onClick={onRerunSetup} className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm font-medium transition hover:bg-muted">
          <RotateCcw className="h-4 w-4" /> Run setup again
        </button>
        <button onClick={onSignOut} className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm font-medium text-destructive transition hover:bg-muted">
          <LogOut className="h-4 w-4" /> Sign out
        </button>
      </div>
    </SlideOver>
  );
}

/** The signature text (saved when you leave the box) and which apps add it. */
function SignatureSettings({ settings, update }: { settings: RelaySettings; update: (patch: Partial<RelaySettings>) => void }) {
  const [draft, setDraft] = useState(settings.signature);
  const save = () => { if (draft !== settings.signature) update({ signature: draft }); };
  // Saved shortly after typing stops, so closing Settings right away doesn't lose it.
  useEffect(() => {
    const timer = setTimeout(save, 600);
    return () => clearTimeout(timer);
  }, [draft]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="mt-2 rounded-xl border p-3">
      <textarea value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={save} rows={3} spellCheck={false}
        placeholder={"e.g. — Ashish\n<small>Sent from Sangam</small>"}
        className="w-full resize-y rounded-lg border bg-card px-2.5 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" />
      <p className="mt-1 text-[11px] text-muted-foreground">Added after a blank line to messages you write. Simple HTML like &lt;b&gt; or &lt;small&gt; works.</p>
      <p className="mt-2.5 text-[11px] font-medium text-muted-foreground">Add to messages on:</p>
      <ChannelChecks value={settings.signatureChannels} onChange={(signatureChannels) => update({ signatureChannels })} />
    </div>
  );
}

/** Tags on number keys 1–9: pick, reorder (← →) and remove. */
function QuickTagSettings({ settings, update, allTags }: { settings: RelaySettings; update: (patch: Partial<RelaySettings>) => void; allTags: string[] }) {
  // Until you choose, the keys use your most-used tags (saved the first time a number key is pressed).
  const tags = settings.quickTags.length ? settings.quickTags : allTags.slice(0, 9);
  const save = (next: string[]) => update({ quickTags: next.slice(0, 9) });
  const move = (i: number, by: number) => {
    const next = [...tags];
    const j = i + by;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j]!, next[i]!];
    save(next);
  };
  const [adding, setAdding] = useState("");
  const add = (tag: string) => {
    const t = tag.trim().toLowerCase();
    if (t && !tags.includes(t) && tags.length < 9) save([...tags, t]);
    setAdding("");
  };
  const suggestions = allTags.filter((t) => !tags.includes(t));
  return (
    <div className="mt-2 rounded-xl border p-3">
      <p className="text-[11px] text-muted-foreground">With a chat open (or several selected), press a number to add or remove its tag.</p>
      <div className="mt-2 space-y-1">
        {tags.map((t, i) => (
          <div key={t} className="group flex items-center gap-2 rounded-lg px-1.5 py-1 text-sm hover:bg-muted">
            <kbd className="grid h-5 w-5 place-items-center rounded border text-[10px] font-bold">{i + 1}</kbd>
            <span className="min-w-0 flex-1 truncate">{t}</span>
            <button onClick={() => move(i, -1)} disabled={i === 0} title="Move up" className="px-1 text-xs text-muted-foreground opacity-0 transition group-hover:opacity-100 disabled:invisible">↑</button>
            <button onClick={() => move(i, 1)} disabled={i === tags.length - 1} title="Move down" className="px-1 text-xs text-muted-foreground opacity-0 transition group-hover:opacity-100 disabled:invisible">↓</button>
            <button onClick={() => save(tags.filter((x) => x !== t))} title={`Remove “${t}” from quick tags`} className="grid h-5 w-5 place-items-center rounded text-muted-foreground hover:text-destructive"><X className="h-3 w-3" /></button>
          </div>
        ))}
        {!tags.length && <p className="px-1.5 text-xs text-muted-foreground">No tags yet.</p>}
      </div>
      {tags.length < 9 && (
        <div className="mt-2 flex gap-1.5">
          <input value={adding} onChange={(e) => setAdding(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(adding); }} list="quick-tag-options" maxLength={32}
            placeholder={`Add tag for key ${tags.length + 1}`} className="min-w-0 flex-1 rounded-lg border bg-card px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring" />
          <datalist id="quick-tag-options">{suggestions.map((t) => <option key={t} value={t} />)}</datalist>
          <button onClick={() => add(adding)} disabled={!adding.trim()} className="rounded-lg bg-primary px-3 text-sm font-semibold text-primary-foreground disabled:opacity-40">Add</button>
        </div>
      )}
    </div>
  );
}

/** A checkbox per app (Teams isn't connectable yet), with All / None. */
function ChannelChecks({ value, onChange }: { value: ChannelId[]; onChange: (channels: ChannelId[]) => void }) {
  const toggle = (id: ChannelId) => onChange(value.includes(id) ? value.filter((c) => c !== id) : [...value, id]);
  return (
    <>
      <div className="mt-1.5 grid grid-cols-2 gap-1.5">
        {CHANNELS.filter((c) => c.id !== "teams").map((c) => (
          <label key={c.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1 text-sm hover:bg-muted">
            <input type="checkbox" checked={value.includes(c.id)} onChange={() => toggle(c.id)} className="h-3.5 w-3.5 accent-[var(--primary)]" />
            <c.icon className={`h-3.5 w-3.5 ${c.color}`} /> {c.name}
          </label>
        ))}
      </div>
      <div className="mt-1.5 flex gap-3 text-[11px]">
        <button onClick={() => onChange(CHANNELS.map((c) => c.id))} className="text-primary hover:underline">All</button>
        <button onClick={() => onChange([])} className="text-muted-foreground hover:underline">None</button>
      </div>
    </>
  );
}

function Toggle({ on, label, hint, onClick }: { on: boolean; label: string; hint?: string; onClick: () => void }) {
  return (
    <button onClick={onClick} aria-pressed={on} className="flex w-full items-center justify-between gap-3 rounded-lg px-1.5 py-1.5 text-left text-sm font-medium hover:bg-muted">
      <span>
        {label}
        {hint && <span className="block text-[11px] font-normal text-muted-foreground">{hint}</span>}
      </span>
      <span className={`h-5 w-9 shrink-0 rounded-full p-0.5 transition ${on ? "bg-primary" : "bg-muted"}`}>
        <span className={`block h-4 w-4 rounded-full bg-card shadow transition ${on ? "translate-x-4" : ""}`} />
      </span>
    </button>
  );
}

/** Desktop pop-ups (asks the browser first), sound, which apps notify, and the muted chats. */
function NotificationSettings({ settings, update, onTest }: { settings: RelaySettings; update: (patch: Partial<RelaySettings>) => void; onTest: () => void }) {
  const [permission, setPermission] = useState(desktopPermission);
  const desktopOn = settings.notifyDesktop && permission === "granted";
  const toggleDesktop = async () => {
    if (desktopOn) return update({ notifyDesktop: false });
    const granted = await requestDesktop();
    setPermission(desktopPermission());
    if (granted) update({ notifyDesktop: true });
  };
  return (
    <div className="mt-2 rounded-xl border p-3">
      <Toggle on={desktopOn} label="Desktop notifications" hint="Pop up on your computer when Sangam isn't the window you're in" onClick={() => void toggleDesktop()} />
      {!desktopSupported() ? (
        <p className="px-1.5 text-[11px] text-destructive">This browser doesn't support desktop notifications.</p>
      ) : permission === "denied" && (
        <p className="px-1.5 text-[11px] text-destructive">Blocked by the browser. Click the 🔒 icon in the address bar → Notifications → Allow, then reload.</p>
      )}
      <Toggle on={settings.notifySound} label="Sound" onClick={() => update({ notifySound: !settings.notifySound })} />
      <p className="mt-2.5 text-[11px] font-medium text-muted-foreground">Notify me about:</p>
      <ChannelChecks value={settings.notifyChannels} onChange={(notifyChannels) => update({ notifyChannels })} />
      {settings.mutedChats.length > 0 && (
        <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
          {settings.mutedChats.length} muted chat{settings.mutedChats.length > 1 ? "s" : ""}
          <button onClick={() => update({ mutedChats: [] })} className="text-primary hover:underline">Unmute all</button>
        </div>
      )}
      <button onClick={onTest} className="mt-2.5 flex w-full items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition hover:bg-muted">
        <BellRing className="h-4 w-4" /> Send test notification
      </button>
    </div>
  );
}

export function ThemePicker({ settings, update, large }: { settings: RelaySettings; update: (patch: Partial<RelaySettings>) => void; large?: boolean }) {
  return (
    <>
      <div className="mt-2 grid grid-cols-2 gap-2">
        {([{ id: false, label: "Light", icon: Sun }, { id: true, label: "Dark", icon: Moon }] as const).map((t) => (
          <button key={t.label} onClick={() => update({ dark: t.id })}
            className={`flex items-center justify-center gap-2 rounded-xl border px-3 text-sm font-medium transition ${large ? "py-3.5" : "py-2.5"} ${settings.dark === t.id ? "border-primary bg-accent text-accent-foreground" : "hover:bg-muted"}`}>
            <t.icon className="h-4 w-4" /> {t.label}
          </button>
        ))}
      </div>
      <SectionLabel className="mt-4">Background</SectionLabel>
      <div className={`mt-2 grid gap-2 ${large ? "grid-cols-4" : "grid-cols-2"}`}>
        {BACKGROUNDS.map((b) => (
          <button key={b.id} onClick={() => update({ bg: b.id })}
            className={`flex items-center gap-2 rounded-xl border px-3 py-2.5 text-sm font-medium transition ${large ? "flex-col" : ""} ${settings.bg === b.id ? "border-primary bg-accent text-accent-foreground" : "hover:bg-muted"}`}>
            <span className={`rounded-full border ${large ? "h-8 w-full rounded-lg" : "h-5 w-5"}`} style={{ backgroundColor: settings.dark ? b.dark : b.light }} />
            {b.name}
          </button>
        ))}
      </div>
    </>
  );
}

/** Adds a tag to one chat or to every selected chat. */
export function TagDialog({ targets, existing, quickTags, onAdd, onRemove, onClose }: {
  targets: Conversation[]; existing: string[]; quickTags: string[]; onAdd: (tag: string) => void; onRemove: (tag: string) => void; onClose: () => void;
}) {
  // Tags on any of these chats; ✕ takes it off all of them.
  const current = [...new Set(targets.flatMap((c) => c.tags))];
  // Tags every target already has don't need suggesting.
  const shared = existing.filter((t) => targets.every((c) => c.tags.includes(t)));
  const [text, setText] = useState("");
  const add = (tag = text) => { if (tag.trim()) { onAdd(tag.trim().toLowerCase()); onClose(); } };
  // Tags already used elsewhere, matching what's typed, so the same tag is reused instead of retyped.
  const suggestions = existing.filter((t) => !shared.includes(t) && t.includes(text.trim().toLowerCase())).slice(0, 12);
  return (
    <Backdrop onClick={onClose} className="grid place-items-center p-4">
      <motion.div {...dialogMotion} className="w-72 rounded-2xl border bg-popover p-4 shadow-soft" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold">{current.length ? "Tags" : "Add tag"}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">{targets.length === 1 ? `Tag “${targets[0]!.name}”` : `Tag ${targets.length} chats`}</p>
        {current.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {current.map((t) => (
              <span key={t} className="flex items-center gap-1 rounded-full bg-accent py-0.5 pl-2 pr-1 text-[11px] font-medium text-accent-foreground">
                <Tag className="h-2.5 w-2.5" />{t}
                <button onClick={() => onRemove(t)} title={`Remove “${t}”`} className="grid h-4 w-4 place-items-center rounded-full hover:bg-destructive/15 hover:text-destructive"><X className="h-3 w-3" /></button>
              </span>
            ))}
          </div>
        )}
        <input autoFocus value={text} onChange={(e) => setText(e.target.value)} maxLength={32}
          onKeyDown={(e) => { if (e.key === "Enter") add(); if (e.key === "Escape") onClose(); }}
          placeholder="e.g. urgent, client…"
          className="mt-3 w-full rounded-lg border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" />
        {suggestions.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {suggestions.map((t) => (
              <button key={t} onClick={() => add(t)} className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground">
                {quickTags.includes(t) ? <kbd className="text-[9px] font-bold">{quickTags.indexOf(t) + 1}</kbd> : <Tag className="h-2.5 w-2.5" />}{t}
              </button>
            ))}
          </div>
        )}
        <p className="mt-2 text-[10px] text-muted-foreground">Tip: with a chat open or selected, press 1–9 to toggle a quick tag.</p>
        <div className="mt-3 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted">Cancel</button>
          <button onClick={() => add()} disabled={!text.trim()} className="rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-40">Add</button>
        </div>
      </motion.div>
    </Backdrop>
  );
}
