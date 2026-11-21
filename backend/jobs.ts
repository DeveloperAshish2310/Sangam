import { emit } from "./events";

/**
 * Every call Sangam makes to a service goes through that account's queue:
 *  - priorities: what you're waiting for (sending, opening a file) runs before background sync;
 *  - concurrency and spacing per channel, so bursts never trip a service's rate limit;
 *  - dedupe: asking for the same job (e.g. "sync") while it's queued shares the queued one;
 *  - rate limits pause the whole account (its quota is shared) and the job retries afterwards;
 *    brief network errors retry with backoff; anything else fails straight away.
 */

export type Priority = "high" | "normal" | "low";
export type JobState = "queued" | "running" | "waiting" | "done" | "failed";

export type JobInfo = {
  id: number;
  name: string;
  label: string;
  priority: Priority;
  state: JobState;
  attempts: number;
  queuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
};

export type JobOptions = {
  /** Stable name; with `dedupe`, a queued job of the same name is shared instead of added again. */
  name: string;
  /** Shown in the activity list, e.g. "Sending message". Defaults to the name. */
  label?: string;
  priority?: Priority;
  dedupe?: boolean;
  /** Retries after rate limits or network errors (default 4). */
  retries?: number;
  /**
   * False for sends: after a network error the message may already have gone out, so it isn't
   * repeated. (A rate-limit refusal is always safe to retry: nothing was done.)
   */
  repeatable?: boolean;
  /** Outgoing messages: spaced by the channel's send gap so the service never sees a burst. */
  paced?: boolean;
  /** A job running longer than this is given up on and its slot freed (default by priority). */
  timeoutMs?: number;
};

/**
 * concurrency: jobs at once. background: how many of those slots background sync may take, so
 * sends and downloads always have room. sendGapMs: minimum gap between outgoing messages only;
 * everything else (downloads, reads) runs in parallel freely. Rate limits are still handled by
 * pausing, so these can be generous.
 */
type Limits = { concurrency: number; background: number; sendGapMs: number };

const LIMITS: Record<string, Limits> = {
  // Quota: 250 units/s per user (a thread fetch is 10).
  gmail: { concurrency: 10, background: 2, sendGapMs: 0 },
  // Each download / mark-read opens its own IMAP connection; servers allow ~10 per user.
  mail: { concurrency: 5, background: 1, sendGapMs: 0 },
  // ~1 message/s per chat; GramJS waits out short flood limits by itself.
  telegram: { concurrency: 8, background: 2, sendGapMs: 300 },
  // Media downloads come from WhatsApp's CDN; only sending needs care (bursts risk a ban).
  whatsapp: { concurrency: 6, background: 1, sendGapMs: 1000 },
  demo: { concurrency: 8, background: 2, sendGapMs: 0 },
};

const TIMEOUT: Record<Priority, number> = { high: 2 * 60_000, normal: 5 * 60_000, low: 10 * 60_000 };

const RANK: Record<Priority, number> = { high: 0, normal: 1, low: 2 };
const HISTORY = 30;
const MAX_PAUSE_MS = 15 * 60_000;

type Job = JobInfo & { opts: JobOptions; fn: () => Promise<unknown>; promise: Promise<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void; notBefore: number };

/** How long a rate-limit error asks us to wait (ms), or null if it isn't one. */
export function rateLimitDelay(error: unknown): number | null {
  const e = error as { status?: number; code?: number | string; statusCode?: number; seconds?: number; message?: string; response?: { headers?: Record<string, string> } };
  // Telegram: FloodWaitError carries the exact wait.
  if (typeof e.seconds === "number" && /flood/i.test(e.message ?? "")) return e.seconds * 1000;
  const status = e.status ?? e.statusCode ?? (typeof e.code === "number" ? e.code : undefined);
  const limited = status === 429 || ((status === 403 || e.code === 403) && /rate ?limit|quota/i.test(e.message ?? "")) || /too many requests|rate-overlimit/i.test(e.message ?? "");
  if (!limited) return null;
  const retryAfter = Number(e.response?.headers?.["retry-after"]);
  return Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0;
}

const TRANSIENT = /ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|network|timed? ?out|Connection Closed/i;
const isTransient = (error: unknown) => {
  const e = error as { status?: number; code?: number | string; message?: string };
  const status = typeof e.status === "number" ? e.status : typeof e.code === "number" ? e.code : 0;
  return status >= 500 || TRANSIENT.test(`${e.code ?? ""} ${e.message ?? ""}`);
};

let nextId = 1;
let emitTimer: NodeJS.Timeout | undefined;
// Activity changes come in bursts; the page refetches at most a few times a second.
const changed = () => {
  emitTimer ??= setTimeout(() => {
    emitTimer = undefined;
    emit({ type: "jobs" });
  }, 300);
};

export class AccountQueue {
  private queue: Job[] = [];
  private running = new Set<Job>();
  private history: JobInfo[] = [];
  private lastSend = 0;
  private timer: NodeJS.Timeout | undefined;
  private rateLimits = 0;
  pausedUntil = 0;
  pauseReason: string | null = null;

  constructor(
    readonly accountId: number,
    readonly channel: string,
    private limits: Limits = LIMITS[channel] ?? { concurrency: 4, background: 1, sendGapMs: 500 },
  ) {}

  run<T>(opts: JobOptions, fn: () => Promise<T>): Promise<T> {
    if (opts.dedupe) {
      const same = this.queue.find((j) => j.name === opts.name);
      if (same) {
        // Someone needs it sooner: move it up.
        if (RANK[opts.priority ?? "normal"] < RANK[same.priority]) same.priority = opts.priority ?? "normal";
        return same.promise as Promise<T>;
      }
    }
    let resolve!: (v: unknown) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<unknown>((res, rej) => ((resolve = res), (reject = rej)));
    const job: Job = {
      id: nextId++,
      name: opts.name,
      label: opts.label ?? opts.name,
      priority: opts.priority ?? "normal",
      state: "queued",
      attempts: 0,
      queuedAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      error: null,
      opts,
      fn,
      promise,
      resolve,
      reject,
      notBefore: 0,
    };
    this.queue.push(job);
    changed();
    this.pump();
    return promise as Promise<T>;
  }

  private pump() {
    clearTimeout(this.timer);
    this.timer = undefined;
    const now = Date.now();
    if (!this.queue.length) return;
    if (this.pausedUntil > now) {
      this.timer = setTimeout(() => this.pump(), this.pausedUntil - now);
      return;
    }
    let nextCheck = Infinity;
    const order = [...this.queue].sort((a, b) => RANK[a.priority] - RANK[b.priority] || a.queuedAt - b.queuedAt);
    for (const job of order) {
      if (this.running.size >= this.limits.concurrency) return; // a finishing job pumps again
      if (job.notBefore > now) { nextCheck = Math.min(nextCheck, job.notBefore); continue; }
      if (job.priority === "low" && [...this.running].filter((j) => j.priority === "low").length >= this.limits.background) continue;
      if (job.opts.paced) {
        const at = this.lastSend + this.limits.sendGapMs;
        if (at > now) { nextCheck = Math.min(nextCheck, at); continue; }
        this.lastSend = now;
      }
      this.queue.splice(this.queue.indexOf(job), 1);
      void this.execute(job);
    }
    if (nextCheck < Infinity) this.timer = setTimeout(() => this.pump(), Math.max(nextCheck - now, 10));
  }

  private async execute(job: Job) {
    this.running.add(job);
    job.state = "running";
    job.attempts++;
    job.startedAt = Date.now();
    changed();
    try {
      // A job that hangs (dead connection, a service that never answers) mustn't hold its slot forever.
      const limit = job.opts.timeoutMs ?? TIMEOUT[job.priority];
      let timer: NodeJS.Timeout | undefined;
      const value = await Promise.race([
        job.fn(),
        new Promise<never>((_, reject) => (timer = setTimeout(() => reject(Object.assign(new Error(`Timed out after ${Math.round(limit / 1000)}s`), { timedOut: true })), limit))),
      ]).finally(() => clearTimeout(timer));
      this.rateLimits = 0;
      this.finish(job, "done", null);
      job.resolve(value);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const limitedFor = rateLimitDelay(error);
      const retries = job.opts.retries ?? 4;
      if (limitedFor !== null && job.attempts <= retries) {
        // The whole account waits: its quota is shared by every job.
        this.rateLimits++;
        const pause = Math.min(Math.max(limitedFor, 30_000 * 2 ** (this.rateLimits - 1)), MAX_PAUSE_MS);
        this.pausedUntil = Math.max(this.pausedUntil, Date.now() + pause);
        this.pauseReason = "Rate limited by the service";
        console.log(`[jobs] ${this.channel}#${this.accountId} rate limited; pausing ${Math.round(pause / 1000)}s, then retrying "${job.label}"`);
        this.requeue(job, message);
      } else if (job.opts.repeatable !== false && !(error as { timedOut?: boolean }).timedOut && isTransient(error) && job.attempts <= Math.min(retries, 3)) {
        job.notBefore = Date.now() + 2_000 * 2 ** (job.attempts - 1);
        this.requeue(job, message);
      } else {
        this.finish(job, "failed", message);
        job.reject(error);
      }
    } finally {
      this.running.delete(job);
      this.pump();
    }
  }

  private requeue(job: Job, error: string) {
    job.state = "waiting";
    job.error = error;
    this.queue.push(job);
    changed();
  }

  private finish(job: Job, state: "done" | "failed", error: string | null) {
    job.state = state;
    job.error = error;
    job.finishedAt = Date.now();
    if (this.pausedUntil <= Date.now()) this.pauseReason = null;
    const { opts: _o, fn: _f, promise: _p, resolve: _r, reject: _j, notBefore: _n, ...info } = job;
    this.history = [info, ...this.history].slice(0, HISTORY);
    changed();
  }

  /** Jobs no longer wanted (account stopped): they fail fast instead of hanging. */
  cancelAll() {
    clearTimeout(this.timer);
    for (const job of this.queue.splice(0)) {
      this.finish(job, "failed", "Cancelled");
      job.reject(new Error("Cancelled: the account was stopped"));
    }
  }

  snapshot() {
    const info = (j: Job): JobInfo => {
      const { opts: _o, fn: _f, promise: _p, resolve: _r, reject: _j, notBefore: _n, ...rest } = j;
      return rest;
    };
    const paused = this.pausedUntil > Date.now();
    return {
      accountId: this.accountId,
      channel: this.channel,
      pausedUntil: paused ? this.pausedUntil : null,
      pauseReason: paused ? this.pauseReason : null,
      running: [...this.running].map(info),
      queued: this.queue.map(info),
      recent: this.history.slice(0, 10),
    };
  }
}

const queues = new Map<number, AccountQueue>();

export function queueFor(account: { id: number; channel: string; status?: string }) {
  let q = queues.get(account.id);
  if (!q) {
    q = new AccountQueue(account.id, account.status === "demo" ? "demo" : account.channel);
    queues.set(account.id, q);
  }
  return q;
}

export function dropQueue(accountId: number) {
  queues.get(accountId)?.cancelAll();
  queues.delete(accountId);
  changed();
}

export const jobsSnapshot = () => [...queues.values()].map((q) => q.snapshot());
