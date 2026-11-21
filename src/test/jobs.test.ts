import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountQueue, rateLimitDelay } from "../../backend/jobs";

const tick = () => vi.advanceTimersByTimeAsync(0);

describe("account job queue", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("runs what you're waiting for before background sync", async () => {
    const q = new AccountQueue(1, "x", { concurrency: 1, background: 1, sendGapMs: 0 });
    const order: string[] = [];
    let release!: () => void;
    void q.run({ name: "first" }, () => new Promise<void>((r) => (release = () => { order.push("first"); r(); })));
    void q.run({ name: "sync", priority: "low" }, async () => void order.push("sync"));
    void q.run({ name: "send", priority: "high" }, async () => void order.push("send"));
    await tick();
    release();
    await vi.advanceTimersByTimeAsync(50);
    expect(order).toEqual(["first", "send", "sync"]);
  });

  it("shares a queued job of the same name", async () => {
    const q = new AccountQueue(1, "x", { concurrency: 1, background: 1, sendGapMs: 0 });
    const fn = vi.fn(async () => "synced");
    let release!: () => void;
    void q.run({ name: "busy" }, () => new Promise<void>((r) => (release = r)));
    const a = q.run({ name: "sync", dedupe: true }, fn);
    const b = q.run({ name: "sync", dedupe: true }, fn);
    await tick();
    release();
    await vi.advanceTimersByTimeAsync(50);
    await expect(a).resolves.toBe("synced");
    await expect(b).resolves.toBe("synced");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("pauses the whole account on a rate limit, then retries", async () => {
    const q = new AccountQueue(1, "x", { concurrency: 2, background: 2, sendGapMs: 0 });
    let calls = 0;
    const limited = q.run({ name: "sync" }, async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error("Quota exceeded for quota metric"), { code: 403 });
      return "ok";
    });
    await tick();
    const other = vi.fn(async () => "sent");
    const send = q.run({ name: "send", priority: "high" }, other);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(other).not.toHaveBeenCalled(); // still paused
    expect(q.snapshot().pausedUntil).not.toBeNull();
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(send).resolves.toBe("sent");
    await expect(limited).resolves.toBe("ok");
  });

  it("never repeats a send after a network error (it may have gone out)", async () => {
    const q = new AccountQueue(1, "x", { concurrency: 1, background: 1, sendGapMs: 0 });
    const fn = vi.fn(async () => { throw new Error("socket hang up"); });
    const p = q.run({ name: "send", repeatable: false }, fn);
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(p).rejects.toThrow("socket hang up");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a sync after a network error", async () => {
    const q = new AccountQueue(1, "x", { concurrency: 1, background: 1, sendGapMs: 0 });
    let calls = 0;
    const p = q.run({ name: "sync" }, async () => {
      if (++calls < 3) throw new Error("ECONNRESET");
      return "ok";
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(p).resolves.toBe("ok");
    expect(calls).toBe(3);
  });

  it("frees the slot of a job that hangs", async () => {
    const q = new AccountQueue(1, "x", { concurrency: 1, background: 1, sendGapMs: 0 });
    const stuck = q.run({ name: "stuck", timeoutMs: 5_000 }, () => new Promise(() => {}));
    stuck.catch(() => {});
    const next = q.run({ name: "next" }, async () => "ran");
    await vi.advanceTimersByTimeAsync(5_100);
    await expect(stuck).rejects.toThrow("Timed out");
    await expect(next).resolves.toBe("ran");
  });

  it("keeps room for sends while background sync runs", async () => {
    const q = new AccountQueue(1, "x", { concurrency: 3, background: 1, sendGapMs: 0 });
    const started: string[] = [];
    for (const n of ["sync1", "sync2"]) void q.run({ name: n, priority: "low" }, () => (started.push(n), new Promise(() => {})));
    void q.run({ name: "send", priority: "high" }, async () => void started.push("send"));
    await tick();
    expect(started.sort()).toEqual(["send", "sync1"]); // sync2 waits: only one background slot
  });

  it("runs downloads in parallel but spaces out sends", async () => {
    const q = new AccountQueue(1, "x", { concurrency: 6, background: 1, sendGapMs: 1000 });
    const started: string[] = [];
    for (const n of ["d1", "d2", "d3"]) void q.run({ name: n }, () => (started.push(n), new Promise(() => {})));
    for (const n of ["s1", "s2"]) void q.run({ name: n, priority: "high", paced: true }, async () => void started.push(n));
    await tick();
    expect(started.sort()).toEqual(["d1", "d2", "d3", "s1"]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(started).toContain("s2");
  });

  it("recognises rate-limit errors from each service", () => {
    expect(rateLimitDelay({ code: 429, message: "Too Many Requests" })).toBe(0);
    expect(rateLimitDelay({ code: 403, message: "Quota exceeded for quota metric" })).toBe(0);
    expect(rateLimitDelay({ message: "A wait of 42 seconds is required (caused by FloodWait)", seconds: 42 })).toBe(42_000);
    expect(rateLimitDelay({ code: 403, message: "Forbidden" })).toBeNull();
    expect(rateLimitDelay(new Error("boom"))).toBeNull();
  });
});
