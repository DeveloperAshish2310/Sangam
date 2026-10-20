import { Archive, Inbox, MoreHorizontal, Plus, Settings, Sparkles, Star } from "lucide-react";
import { CHANNELS, type Account, type ChannelId, type User } from "@/lib/relay";
import { ActivePill, initials, NavItem } from "./common";
import { PopCount } from "./motion";

export type View = ChannelId | "all" | "starred" | "archived" | `account:${number}`;

/** The account id when the view is a single account, else null. */
export const viewAccount = (v: View) => (v.startsWith("account:") ? Number(v.slice(8)) : null);

type Props = {
  user: User;
  view: View;
  onView: (v: View) => void;
  collapsed: boolean;
  channels: ChannelId[];
  connectedCount: number;
  unread: (channel?: ChannelId) => number;
  /** Accounts per channel, only for channels with more than one, shown nested under it. */
  multiAccounts: Partial<Record<ChannelId, Account[]>>;
  accountUnread: (accountId: number) => number;
  archivedCount: number;
  onProfile: () => void;
  onSettings: () => void;
};

export function Sidebar({ user, view, onView, collapsed, channels, connectedCount, unread, multiAccounts, accountUnread, archivedCount, onProfile, onSettings }: Props) {
  return (
    <aside className={`flex shrink-0 flex-col bg-sidebar text-sidebar-foreground transition-all duration-300 ${collapsed ? "w-[72px]" : "w-64"}`}>
      <div className={`flex items-center gap-2 px-5 py-6 ${collapsed ? "justify-center px-0" : ""}`}>
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-sidebar-primary text-sidebar-primary-foreground"><Sparkles className="h-5 w-5" /></div>
        {!collapsed && <span className="font-display text-xl font-semibold">Sangam</span>}
      </div>
      <nav className="space-y-1 px-3">
        <NavItem icon={Inbox} label="All inbox" count={unread()} active={view === "all"} collapsed={collapsed} onClick={() => onView("all")} />
        <NavItem icon={Star} label="Starred" active={view === "starred"} collapsed={collapsed} onClick={() => onView("starred")} />
        <NavItem icon={Archive} label="Archived" count={archivedCount} active={view === "archived"} collapsed={collapsed} onClick={() => onView("archived")} />
      </nav>
      {!collapsed && <p className="mt-6 px-6 text-[11px] font-semibold uppercase tracking-widest text-sidebar-foreground/50">Channels</p>}
      <nav className="mt-2 space-y-1 px-3">
        {CHANNELS.filter((c) => channels.includes(c.id)).map((c) => (
          <div key={c.id}>
          <button onClick={() => onView(c.id)} title={c.name}
            className={`relative isolate flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${collapsed ? "justify-center px-0" : ""} ${view === c.id ? "text-sidebar-accent-foreground" : "hover:bg-sidebar-accent/60"}`}>
            {view === c.id && <ActivePill />}
            <span className={`relative h-2.5 w-2.5 shrink-0 rounded-full ${c.bg}`} />
            {!collapsed && <span className="relative flex-1 text-left">{c.name}</span>}
            {!collapsed && unread(c.id) > 0 && <PopCount value={unread(c.id)} className="relative text-xs text-sidebar-foreground/60" />}
          </button>
          {!collapsed && multiAccounts[c.id]?.map((a) => {
            const id: View = `account:${a.id}`;
            return (
              <button key={a.id} onClick={() => onView(id)} title={`Only ${a.displayName}`}
                className={`relative isolate ml-5 flex w-[calc(100%-1.25rem)] items-center gap-2 rounded-lg px-3 py-1.5 text-xs transition-colors ${view === id ? "text-sidebar-accent-foreground" : "text-sidebar-foreground/70 hover:bg-sidebar-accent/60"}`}>
                {view === id && <ActivePill />}
                <span className={`relative h-1.5 w-1.5 shrink-0 rounded-full ${c.bg} opacity-60`} />
                <span className="relative min-w-0 flex-1 truncate text-left">{a.displayName}</span>
                {accountUnread(a.id) > 0 && <PopCount value={accountUnread(a.id)} className="relative text-sidebar-foreground/60" />}
              </button>
            );
          })}
          </div>
        ))}
        <button onClick={onProfile} className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-sidebar-foreground/60 hover:bg-sidebar-accent/60 ${collapsed ? "justify-center px-0" : ""}`} title="Connect account">
          <Plus className="h-4 w-4 shrink-0" /> {!collapsed && "Connect account"}
        </button>
      </nav>
      <div className={`mt-auto flex items-center gap-3 border-t border-sidebar-border p-4 ${collapsed ? "flex-col" : ""}`}>
        <button onClick={onProfile} title="Open profile" className={`flex flex-1 items-center gap-3 rounded-lg text-left transition hover:bg-sidebar-accent/60 ${collapsed ? "p-1" : "-m-1 p-1"}`}>
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-sidebar-accent font-semibold">{initials(user.name)}</div>
          {!collapsed && (
            <span className="min-w-0 flex-1 text-sm">
              <p className="truncate font-medium">{user.name}</p>
              <p className="text-xs text-sidebar-foreground/50">{connectedCount ? `${connectedCount} channel${connectedCount > 1 ? "s" : ""} live` : "No channels connected"}</p>
            </span>
          )}
        </button>
        {!collapsed && (
          <button onClick={onProfile} title="Profile options" className="grid h-8 w-8 place-items-center rounded-lg text-sidebar-foreground/60 hover:bg-sidebar-accent/60">
            <MoreHorizontal className="h-4 w-4" />
          </button>
        )}
        <button onClick={onSettings} title="Settings" className="grid h-8 w-8 place-items-center rounded-lg text-sidebar-foreground/60 hover:bg-sidebar-accent/60">
          <Settings className="h-4 w-4" />
        </button>
      </div>
    </aside>
  );
}
