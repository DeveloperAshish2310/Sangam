import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { AlertCircle, Loader2, PauseCircle, RefreshCw } from "lucide-react";
import { ch } from "@/lib/relay";
import { useAccounts, useJobs, useRefresh, type QueueInfo } from "@/hooks/use-relay";
import { menuMotion } from "./motion";

const isSync = (name: string) => name === "sync";
const busy = (q: QueueInfo) => q.running.length + q.queued.length > 0;

/** "0:42" until a paused account resumes. */
function useCountdown(until: number | null) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!until) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [until]);
  if (!until) return null;
  const s = Math.max(0, Math.round((until - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Refresh button for the list header: syncs every account now; spins while any sync runs. */
export function RefreshButton() {
  const { data: queues = [] } = useJobs();
  const refresh = useRefresh();
  const syncing = queues.some((q) => [...q.running, ...q.queued].some((j) => isSync(j.name)));
  return (
    <button onClick={() => refresh.mutate(undefined)} title={syncing ? "Syncing… (click to check again)" : "Refresh — check every account for new messages"}
      className="grid h-9 w-9 place-items-center rounded-lg text-muted-foreground hover:bg-muted">
      <RefreshCw className={`h-4 w-4 ${syncing || refresh.isPending ? "animate-spin" : ""}`} />
    </button>
  );
}

function QueueRow({ q, name, onRefresh }: { q: QueueInfo; name: string; onRefresh: () => void }) {
  const C = ch(q.channel === "demo" ? "gmail" : (q.channel as Parameters<typeof ch>[0]));
  const countdown = useCountdown(q.pausedUntil);
  const failed = q.recent.find((j) => j.state === "failed" && j.finishedAt && Date.now() - j.finishedAt < 10 * 60_000);
  const status = q.pausedUntil
    ? `Paused by a rate limit · resumes in ${countdown}`
    : q.running.length
      ? q.running.map((j) => j.label).join(", ")
      : q.queued.length
        ? "Waiting"
        : "Idle";
  return (
    <div className="flex items-start gap-2.5 px-3 py-2.5">
      <C.icon className={`mt-0.5 h-4 w-4 shrink-0 ${C.color}`} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{name}</p>
        <p className={`flex items-center gap-1 truncate text-[11px] ${q.pausedUntil ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}`}>
          {q.pausedUntil ? <PauseCircle className="h-3 w-3 shrink-0" /> : q.running.length ? <Loader2 className="h-3 w-3 shrink-0 animate-spin" /> : null}
          <span className="truncate">{status}{q.queued.length > 0 && ` · ${q.queued.length} queued`}</span>
        </p>
        {failed && (
          <p className="mt-0.5 flex items-center gap-1 truncate text-[11px] text-destructive" title={failed.error ?? ""}>
            <AlertCircle className="h-3 w-3 shrink-0" /> {failed.label} failed: {failed.error}
          </p>
        )}
      </div>
      <button onClick={onRefresh} title={`Refresh ${name}`} className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted">
        <RefreshCw className={`h-3.5 w-3.5 ${[...q.running, ...q.queued].some((j) => isSync(j.name)) ? "animate-spin" : ""}`} />
      </button>
    </div>
  );
}

/** A small status next to "Live": what's being synced or sent, and accounts paused by a rate limit. Click for details. */
export function ActivityStatus() {
  const { data: queues = [] } = useJobs();
  const { data: accounts = [] } = useAccounts(true);
  const refresh = useRefresh();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  // Every account, including ones that haven't needed a job yet.
  const shown: QueueInfo[] = accounts.map(
    (a) => queues.find((q) => q.accountId === a.id) ?? { accountId: a.id, channel: a.status === "demo" ? "demo" : a.channel, pausedUntil: null, pauseReason: null, running: [], queued: [], recent: [] },
  );
  const paused = shown.filter((q) => q.pausedUntil);
  const active = shown.filter(busy);
  const label = paused.length ? `${paused.length} paused` : active.length ? "Working…" : "Activity";
  const nameOf = (id: number) => accounts.find((a) => a.id === id)?.displayName ?? `Account ${id}`;

  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((v) => !v)} title="What Sangam is syncing and sending"
        className={`flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium hover:bg-muted ${paused.length ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}`}>
        {paused.length ? <PauseCircle className="h-3 w-3" /> : active.length ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
        {label}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div {...menuMotion} className="absolute right-0 top-full z-40 mt-1 w-80 overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-xl">
            <div className="flex items-center justify-between border-b px-3 py-2">
              <p className="text-xs font-semibold">Activity</p>
              <button onClick={() => refresh.mutate(undefined)} className="flex items-center gap-1 text-[11px] font-medium text-primary hover:underline">
                <RefreshCw className="h-3 w-3" /> Refresh all
              </button>
            </div>
            <div className="max-h-80 divide-y overflow-y-auto">
              {shown.length ? (
                shown.map((q) => <QueueRow key={q.accountId} q={q} name={nameOf(q.accountId)} onRefresh={() => refresh.mutate(q.accountId)} />)
              ) : (
                <p className="px-3 py-4 text-center text-xs text-muted-foreground">Nothing has run yet</p>
              )}
            </div>
            <p className="border-t px-3 py-2 text-[10px] leading-snug text-muted-foreground">
              Each account works through its own queue: what you send goes first, syncing waits its turn, and if a service says “slow down” that account pauses and carries on by itself.
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
