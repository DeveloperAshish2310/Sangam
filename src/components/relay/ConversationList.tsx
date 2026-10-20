import { Check, Moon, PanelLeftClose, PanelLeftOpen, Search, Sun, Tag, SquarePen, X, SlidersHorizontal, User, MessageSquareText, CalendarDays } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { PopCount, spring } from "./motion";
import { useLiveStatus } from "@/hooks/use-relay";
import { ch, CHANNELS, formatTime, type ChannelId, type Conversation } from "@/lib/relay";
import { Avatar, avatarUrl, type MenuAction } from "./common";
import type { View } from "./Sidebar";

export type DatePreset = "any" | "today" | "7d" | "30d" | "custom";
/** Everything combines with AND: unread, tagged, any picked channel, name, message text, date. */
export type Filters = {
  unread: boolean;
  tagged: boolean;
  channels: ChannelId[];
  /** Contact / group / sender name contains this. */
  name: string;
  /** Some message body contains this. */
  body: string;
  /** Some message was sent in this period. from/to are yyyy-mm-dd (custom only). */
  date: { preset: DatePreset; from: string; to: string };
};
export const NO_FILTERS: Filters = { unread: false, tagged: false, channels: [], name: "", body: "", date: { preset: "any", from: "", to: "" } };
export const hasAdvanced = (f: Filters) => !!f.name.trim() || !!f.body.trim() || f.date.preset !== "any";
export const hasFilters = (f: Filters) => f.unread || f.tagged || f.channels.length > 0 || hasAdvanced(f);

/** The date filter as epoch-ms bounds [from, to), in local time. */
export function dateBounds(d: Filters["date"]): { from?: number; to?: number } {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const day = 86_400_000;
  switch (d.preset) {
    case "today": return { from: startOfToday.getTime() };
    case "7d": return { from: startOfToday.getTime() - 6 * day };
    case "30d": return { from: startOfToday.getTime() - 29 * day };
    case "custom": {
      // <input type=date> gives yyyy-mm-dd; "T00:00" makes it local midnight, and "to" includes its whole day.
      const from = d.from ? new Date(`${d.from}T00:00`).getTime() : undefined;
      const to = d.to ? new Date(`${d.to}T00:00`).getTime() + day : undefined;
      return { ...(from !== undefined && { from }), ...(to !== undefined && { to }) };
    }
    default: return {};
  }
}

type Props = {
  view: View;
  /** Title for an account view, e.g. "@AshishAshok". */
  viewTitle: string;
  /** Which account a conversation belongs to, when its channel has several; else null. */
  accountLabel: (c: Conversation) => string | null;
  list: Conversation[];
  loading: boolean;
  totalUnread: number;
  channels: ChannelId[];
  activeId: number | null;
  menuConvoId: number | null;
  query: string;
  onQuery: (q: string) => void;
  filters: Filters;
  /** Every tag in use with its chat count, for the per-tag filter row. */
  tags: { tag: string; count: number }[];
  tagFilter: string | null;
  onTagFilter: (tag: string | null) => void;
  onFilters: (f: Filters) => void;
  dark: boolean;
  onToggleDark: () => void;
  onCompose: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onOpen: (id: number) => void;
  onContextMenu: (id: number, x: number, y: number) => void;
  selected: Set<number>;
  onSelect: (id: number, mode: "toggle" | "range") => void;
  bulkActions: MenuAction[];
  onSelectAll: () => void;
  onClearSelection: () => void;
};

/** Whether new messages arrive instantly (live stream up) or via the slower fallback refresh. */
function LiveBadge() {
  const status = useLiveStatus();
  return status === "live" ? (
    <span className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-whatsapp" title="New messages appear instantly">
      <span className="h-1.5 w-1.5 rounded-full bg-whatsapp" /> Live
    </span>
  ) : (
    <span className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-amber-600 dark:text-amber-400" title="Live connection lost — refreshing every few seconds while reconnecting">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" /> Reconnecting…
    </span>
  );
}

function TagChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      className={`flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition ${active ? "border-primary bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted"}`}>
      {children}
    </button>
  );
}

/** Grey placeholder row with a light sweep, shown while conversations load. */
function SkeletonRow() {
  return (
    <div className="flex gap-3 p-3">
      <div className="shimmer h-10 w-10 shrink-0 rounded-full" />
      <div className="flex-1 space-y-2 pt-1">
        <div className="shimmer h-3 w-2/5 rounded" />
        <div className="shimmer h-2.5 w-4/5 rounded" />
      </div>
    </div>
  );
}

/** Ids of conversations that just received an incoming message, for a brief highlight. */
function useNewMessageFlash(list: Conversation[]) {
  const seen = useRef(new Map<number, number>());
  const [flashing, setFlashing] = useState<Set<number>>(new Set());
  useEffect(() => {
    const fresh: number[] = [];
    for (const c of list) {
      const before = seen.current.get(c.id);
      if (before !== undefined && c.lastMessageAt > before && c.lastMessage?.direction === "in") fresh.push(c.id);
      seen.current.set(c.id, c.lastMessageAt);
    }
    if (!fresh.length) return;
    setFlashing((s) => new Set([...s, ...fresh]));
    const t = setTimeout(() => setFlashing((s) => new Set([...s].filter((id) => !fresh.includes(id)))), 1600);
    return () => clearTimeout(t);
  }, [list]);
  return flashing;
}

/**
 * Press-and-hold (touch or mouse) for 450ms to start selecting. Moving more than a few pixels
 * cancels it, so scrolling the list on a phone never selects by accident.
 */
function useLongPress(onLong: (id: number) => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const cancel = () => { clearTimeout(timer.current); origin.current = null; };
  return {
    fired,
    bind: (id: number) => ({
      onPointerDown: (e: React.PointerEvent) => {
        if (e.button !== 0) return;
        fired.current = false;
        origin.current = { x: e.clientX, y: e.clientY };
        const touch = e.pointerType === "touch";
        clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          fired.current = true;
          if (touch) navigator.vibrate?.(15);
          onLong(id);
        }, 450);
      },
      onPointerMove: (e: React.PointerEvent) => {
        if (origin.current && Math.hypot(e.clientX - origin.current.x, e.clientY - origin.current.y) > 8) cancel();
      },
      onPointerUp: cancel,
      onPointerLeave: cancel,
      onPointerCancel: cancel,
    }),
  };
}

const DATE_PRESETS: { id: DatePreset; label: string }[] = [
  { id: "any", label: "Any time" },
  { id: "today", label: "Today" },
  { id: "7d", label: "Last 7 days" },
  { id: "30d", label: "Last 30 days" },
  { id: "custom", label: "Custom…" },
];

function FilterInput({ icon: I, placeholder, value, onChange }: { icon: typeof Search; placeholder: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border bg-background px-2.5 py-1.5">
      <I className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="min-w-0 flex-1 bg-transparent text-xs outline-none" />
      {value && <button onClick={() => onChange("")} title="Clear" className="text-muted-foreground hover:text-foreground"><X className="h-3.5 w-3.5" /></button>}
    </div>
  );
}

export function ConversationList(p: Props) {
  const isSelected = (id: number) => p.selected.has(id);
  const selectedCount = p.list.filter((c) => p.selected.has(c.id)).length;
  const selecting = selectedCount > 0;
  const longPress = useLongPress((id) => p.onSelect(id, "toggle"));
  const flashing = useNewMessageFlash(p.list);
  // Stagger the very first appearance of the list only; later updates animate individually.
  const [firstPaint, setFirstPaint] = useState(true);
  useEffect(() => {
    if (p.loading || !p.list.length) return undefined;
    const t = setTimeout(() => setFirstPaint(false), 600);
    return () => clearTimeout(t);
  }, [p.loading, p.list.length]);
  const f = p.filters;
  const [showAdvanced, setShowAdvanced] = useState(() => hasAdvanced(p.filters));
  // Filters set from elsewhere (e.g. right-click → "More from …") open the panel so they're visible.
  const advancedActive = hasAdvanced(f);
  useEffect(() => {
    if (advancedActive) setShowAdvanced(true);
  }, [advancedActive, f.name, f.body]);
  const toggleChannel = (id: ChannelId) =>
    p.onFilters({ ...f, channels: f.channels.includes(id) ? f.channels.filter((x) => x !== id) : [...f.channels, id] });
  // Channel chips are redundant when the sidebar already narrows to one channel or account.
  const viewIsChannel = p.view !== "all" && p.view !== "starred" && p.view !== "archived";
  const chips: { key: string; label: string; active: boolean; onClick: () => void; dot?: string }[] = [
    { key: "all", label: "All", active: !hasFilters(f), onClick: () => p.onFilters(NO_FILTERS) },
    { key: "unread", label: "Unread", active: f.unread, onClick: () => p.onFilters({ ...f, unread: !f.unread }) },
    { key: "tagged", label: "Tags", active: f.tagged, onClick: () => p.onFilters({ ...f, tagged: !f.tagged }) },
    ...(viewIsChannel ? [] : CHANNELS.filter((c) => p.channels.includes(c.id)).map((c) => ({
      key: c.id, label: c.name, active: f.channels.includes(c.id), onClick: () => toggleChannel(c.id), dot: c.bg,
    }))),
  ];
  const title = p.viewTitle;

  return (
    <section className="flex w-96 shrink-0 flex-col border-r bg-surface">
      <div className="p-5 pb-3">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">{title}</h1>
          <div className="flex gap-1">
            <button onClick={p.onCompose} title="New message" className="grid h-9 w-9 place-items-center rounded-lg text-muted-foreground hover:bg-muted">
              <SquarePen className="h-4 w-4" />
            </button>
            <button onClick={p.onToggleDark} title={p.dark ? "Light mode" : "Dark mode"} className="grid h-9 w-9 place-items-center rounded-lg text-muted-foreground hover:bg-muted">
              <AnimatePresence mode="wait" initial={false}>
                <motion.span key={p.dark ? "sun" : "moon"} initial={{ rotate: -90, scale: 0.5, opacity: 0 }} animate={{ rotate: 0, scale: 1, opacity: 1 }} exit={{ rotate: 90, scale: 0.5, opacity: 0 }} transition={{ duration: 0.2 }}>
                  {p.dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
                </motion.span>
              </AnimatePresence>
            </button>
            <button onClick={p.onToggleCollapsed} title={p.collapsed ? "Expand sidebar" : "Collapse sidebar"} className="grid h-9 w-9 place-items-center rounded-lg text-muted-foreground hover:bg-muted">
              {p.collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
            </button>
          </div>
        </div>
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">{p.totalUnread} unread across all channels</p>
          <LiveBadge />
        </div>
        <div className="mt-4 flex items-center gap-2 rounded-xl border bg-card py-1 pl-3 pr-1">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input value={p.query} onChange={(e) => p.onQuery(e.target.value)} placeholder="Search everything…" className="flex-1 bg-transparent py-1 text-sm outline-none" />
          <button onClick={() => setShowAdvanced((v) => !v)} title="Filter by name, message text or date" aria-expanded={showAdvanced}
            className={`relative grid h-8 w-8 place-items-center rounded-lg transition-colors ${showAdvanced ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted"}`}>
            <SlidersHorizontal className="h-4 w-4" />
            {hasAdvanced(f) && <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-primary" />}
          </button>
        </div>
        <AnimatePresence initial={false}>
          {showAdvanced && (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.22, ease: "easeOut" }} className="overflow-hidden">
              <div className="mt-2 space-y-2 rounded-xl border bg-card p-3">
                <FilterInput icon={User} placeholder="Name — contact, group or sender" value={f.name} onChange={(name) => p.onFilters({ ...f, name })} />
                <FilterInput icon={MessageSquareText} placeholder="Message text contains…" value={f.body} onChange={(body) => p.onFilters({ ...f, body })} />
                <div>
                  <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground"><CalendarDays className="h-3 w-3" /> Messages from</p>
                  <div className="flex flex-wrap gap-1.5">
                    {DATE_PRESETS.map((d) => (
                      <button key={d.id} onClick={() => p.onFilters({ ...f, date: { ...f.date, preset: d.id } })}
                        className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors ${f.date.preset === d.id ? "border-primary bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted"}`}>
                        {d.label}
                      </button>
                    ))}
                  </div>
                  {f.date.preset === "custom" && (
                    <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className="mt-2 flex items-center gap-2 text-xs">
                      <input type="date" value={f.date.from} max={f.date.to || undefined} onChange={(e) => p.onFilters({ ...f, date: { ...f.date, from: e.target.value } })}
                        className="min-w-0 flex-1 rounded-lg border bg-background px-2 py-1.5 outline-none focus:ring-2 focus:ring-ring" aria-label="From date" />
                      <span className="text-muted-foreground">to</span>
                      <input type="date" value={f.date.to} min={f.date.from || undefined} onChange={(e) => p.onFilters({ ...f, date: { ...f.date, to: e.target.value } })}
                        className="min-w-0 flex-1 rounded-lg border bg-background px-2 py-1.5 outline-none focus:ring-2 focus:ring-ring" aria-label="To date" />
                    </motion.div>
                  )}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        <div className="scrollbar-thin mt-3 flex gap-1.5 overflow-x-auto pb-1">
          {chips.map((q) => (
            <motion.button key={q.key} onClick={q.onClick} whileTap={{ scale: 0.92 }} aria-pressed={q.active}
              className={`flex shrink-0 items-center gap-1 rounded-full px-3 py-1 text-xs font-medium transition-colors ${q.active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground"}`}>
              {/* Chips can be combined, so active ones show a tick (except "All"). */}
              {q.active && q.key !== "all" ? <Check className="h-3 w-3" /> : q.dot && <span className={`h-1.5 w-1.5 rounded-full ${q.dot}`} />}
              {q.label}
            </motion.button>
          ))}
        </div>
        {hasFilters(f) && (
          <motion.p initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className="mt-1 text-[11px] text-muted-foreground">
            {p.list.length} chat{p.list.length === 1 ? "" : "s"} match{p.list.length === 1 ? "es" : ""}
            {" · "}<button onClick={() => p.onFilters(NO_FILTERS)} className="font-medium text-primary hover:underline">Clear filters</button>
          </motion.p>
        )}
        {f.tagged && (
          <div className="scrollbar-thin mt-1.5 flex gap-1.5 overflow-x-auto pb-1">
            {p.tags.length === 0 && <p className="text-xs text-muted-foreground">No tags yet — right-click a chat → Add tag.</p>}
            {p.tags.length > 0 && (
              <TagChip active={p.tagFilter === null} onClick={() => p.onTagFilter(null)}>Any tag</TagChip>
            )}
            {p.tags.map(({ tag, count }) => (
              <TagChip key={tag} active={p.tagFilter === tag} onClick={() => p.onTagFilter(tag)}>
                <Tag className="h-2.5 w-2.5" />{tag}<span className="opacity-60">{count}</span>
              </TagChip>
            ))}
          </div>
        )}
      </div>
      <div className="scrollbar-thin flex-1 space-y-1 overflow-y-auto px-3 pb-4">
        {p.loading && Array.from({ length: 7 }, (_, i) => <SkeletonRow key={i} />)}
        <AnimatePresence initial={false}>
        {p.list.map((c, i) => {
          const C = ch(c.channel);
          const via = p.accountLabel(c);
          return (
            <motion.button key={c.id}
              {...longPress.bind(c.id)}
              onClick={(e) => {
                // The click that ends a long-press only started selection; don't also open the chat.
                if (longPress.fired.current) { longPress.fired.current = false; return; }
                if (selecting || e.ctrlKey || e.metaKey) return p.onSelect(c.id, selecting && e.shiftKey ? "range" : "toggle");
                p.onOpen(c.id);
              }}
              onContextMenu={(e) => {
                e.preventDefault(); e.stopPropagation();
                // Touch long-press also fires contextmenu; selection wins there.
                if (longPress.fired.current || selecting) return;
                p.onContextMenu(c.id, e.clientX, e.clientY);
              }}
              aria-pressed={selecting ? isSelected(c.id) : undefined}
              // layout="position": chats glide to their new place when a message moves one to the top.
              layout="position"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0, transition: { ...spring, delay: firstPaint ? Math.min(i, 12) * 0.025 : 0 } }}
              exit={{ opacity: 0, x: -24, transition: { duration: 0.18 } }}
              transition={spring}
              whileTap={{ scale: 0.985 }}
              className={`relative isolate flex w-full gap-3 rounded-xl p-3 text-left transition-colors ${p.activeId === c.id ? "" : "hover:bg-muted"} ${p.menuConvoId === c.id ? "ring-2 ring-ring" : ""} ${flashing.has(c.id) ? "animate-flash" : ""} ${isSelected(c.id) ? "bg-primary/10 ring-1 ring-primary/40" : ""} touch-pan-y select-none [-webkit-touch-callout:none]`}>
              {p.activeId === c.id && <motion.span layoutId="list-active" transition={spring} className="absolute inset-0 -z-10 rounded-xl bg-card shadow-soft ring-1 ring-border" />}
              <div className="relative shrink-0">
                <Avatar name={c.name} channel={c.channel} photo={avatarUrl(c)} />
                <AnimatePresence>
                  {selecting && (
                    <motion.span initial={{ scale: 0, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0, opacity: 0 }} transition={spring}
                      className={`absolute -left-1 -top-1 grid h-5 w-5 place-items-center rounded-full border-2 border-surface ${isSelected(c.id) ? "bg-primary text-primary-foreground" : "bg-muted"}`}>
                      {isSelected(c.id) && <Check className="h-3 w-3" strokeWidth={3} />}
                    </motion.span>
                  )}
                </AnimatePresence>
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <p className={`truncate text-sm ${c.unread ? "font-bold" : "font-medium"}`}>{c.name}</p>
                  <span className="shrink-0 text-xs text-muted-foreground">{formatTime(c.lastMessage?.sentAt ?? c.lastMessageAt)}</span>
                </div>
                {c.subject && <p className="truncate text-xs font-semibold">{c.subject}</p>}
                <div className="flex items-center gap-2">
                  <p className="flex-1 truncate text-xs text-muted-foreground">{c.lastMessage?.direction === "out" && "You: "}{c.lastMessage?.text}</p>
                  {c.unread > 0 && <PopCount value={c.unread} className="grid h-5 min-w-5 place-items-center rounded-full bg-primary px-1.5 text-[10px] font-bold text-primary-foreground" />}
                </div>
                <div className="mt-1 flex items-center gap-1.5">
                  <p className={`shrink-0 text-[10px] font-semibold uppercase tracking-wider ${C.color}`}>{C.name}</p>
                  {via && <p className="min-w-0 truncate text-[10px] font-medium text-muted-foreground" title={`Account: ${via}`}>· {via}</p>}
                  {c.tags.map((t) => (
                    <span key={t} className="flex items-center gap-0.5 rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground"><Tag className="h-2 w-2" />{t}</span>
                  ))}
                </div>
              </div>
            </motion.button>
          );
        })}
        </AnimatePresence>
        {!p.loading && p.list.length === 0 && (
          <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="p-6 text-center text-sm text-muted-foreground">No conversations here.</motion.p>
        )}
      </div>
      <AnimatePresence>
        {selecting && (
          <motion.div initial={{ y: 90, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 90, opacity: 0 }} transition={spring}
            className="border-t bg-card px-3 pb-3 pt-2 shadow-soft">
            <div className="flex items-center gap-2 pb-2 text-xs">
              <span className="flex-1"><PopCount value={selectedCount} className="inline-block font-bold" /> selected</span>
              <button onClick={p.onSelectAll} className="rounded-md px-2 py-1 font-medium text-primary hover:bg-muted">Select all ({p.list.length})</button>
              <button onClick={p.onClearSelection} title="Cancel (Esc)" className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-muted"><X className="h-4 w-4" /></button>
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {p.bulkActions.map((a) => (
                <motion.button key={a.label} whileTap={{ scale: 0.94 }} onClick={a.fn}
                  className={`flex flex-col items-center gap-1 rounded-lg px-2 py-1.5 text-[11px] font-medium transition-colors hover:bg-muted ${a.danger ? "text-destructive" : "text-foreground"}`}>
                  <a.icon className="h-4 w-4" /> {a.label}
                </motion.button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
