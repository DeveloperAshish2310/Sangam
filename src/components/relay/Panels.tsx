import { motion } from "motion/react";
import { Backdrop, dialogMotion } from "./motion";
import { useState, type ReactNode } from "react";
import { Ban, Check, Clock, Database, Image as ImageIcon, Lock, LogOut, Moon, RotateCcw, Settings, ShieldCheck, Star, Sun, Tag, Trash2, X } from "lucide-react";
import { BACKGROUNDS, ch, CHANNELS, type Account, type ChannelId, type Conversation, type Settings as RelaySettings, type User } from "@/lib/relay";
import { Avatar, avatarUrl, initials, SectionLabel, SlideOver } from "./common";

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
          const connectHref = `/api/connect/${c.id}/start`;
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

export function ContactPanel({ convo, account, onClose, onClear, onDelete, onRemoveTag }: {
  convo: Conversation; account: Account | undefined; onClose: () => void; onClear: () => void; onDelete: () => void; onRemoveTag: (tag: string) => void;
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

      <div className="mt-6 rounded-xl border bg-card p-4">
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

      <div className="mt-4 rounded-xl border bg-card">
        <div className="flex items-center justify-between px-4 py-3">
          <p className="flex items-center gap-2 text-sm font-medium"><ImageIcon className="h-4 w-4 text-muted-foreground" /> Media, links and docs</p>
          <span className="text-xs text-muted-foreground">Coming soon</span>
        </div>
      </div>

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

export function SettingsPanel({ settings, update, hasDemo, onDemo, onRerunSetup, onSignOut, onClose }: {
  settings: RelaySettings; update: (patch: Partial<RelaySettings>) => void; hasDemo: boolean;
  onDemo: (load: boolean) => void; onRerunSetup: () => void; onSignOut: () => void; onClose: () => void;
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
export function TagDialog({ targets, existing, onAdd, onClose }: { targets: Conversation[]; existing: string[]; onAdd: (tag: string) => void; onClose: () => void }) {
  // Tags every target already has don't need suggesting.
  const shared = existing.filter((t) => targets.every((c) => c.tags.includes(t)));
  const [text, setText] = useState("");
  const add = (tag = text) => { if (tag.trim()) { onAdd(tag.trim().toLowerCase()); onClose(); } };
  // Tags already used elsewhere, matching what's typed, so the same tag is reused instead of retyped.
  const suggestions = existing.filter((t) => !shared.includes(t) && t.includes(text.trim().toLowerCase())).slice(0, 12);
  return (
    <Backdrop onClick={onClose} className="grid place-items-center p-4">
      <motion.div {...dialogMotion} className="w-72 rounded-2xl border bg-popover p-4 shadow-soft" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold">Add tag</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">{targets.length === 1 ? `Tag “${targets[0]!.name}”` : `Tag ${targets.length} chats`}</p>
        <input autoFocus value={text} onChange={(e) => setText(e.target.value)} maxLength={32}
          onKeyDown={(e) => { if (e.key === "Enter") add(); if (e.key === "Escape") onClose(); }}
          placeholder="e.g. urgent, client…"
          className="mt-3 w-full rounded-lg border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" />
        {suggestions.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {suggestions.map((t) => (
              <button key={t} onClick={() => add(t)} className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground">
                <Tag className="h-2.5 w-2.5" />{t}
              </button>
            ))}
          </div>
        )}
        <div className="mt-3 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted">Cancel</button>
          <button onClick={() => add()} disabled={!text.trim()} className="rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-40">Add</button>
        </div>
      </motion.div>
    </Backdrop>
  );
}
