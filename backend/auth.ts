import { and, eq, gt, inArray, lt } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { newToken, sha256 } from "./crypto";
import { db, schema } from "./db";

export type AuthEnv = { Variables: { userId: number } };

const COOKIE = "relay_session";
const SESSION_DAYS = 30;

export async function createSession(c: Context, userId: number) {
  const token = newToken();
  const expiresAt = Date.now() + SESSION_DAYS * 86_400_000;
  await db.insert(schema.sessions).values({ tokenHash: sha256(token), userId, expiresAt, lastActiveAt: Date.now() });
  await db.delete(schema.sessions).where(lt(schema.sessions.expiresAt, Date.now()));
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    sameSite: "Strict",
    // Plain http on localhost; becomes Secure automatically once served over https (e.g. Tailscale).
    secure: c.req.header("x-forwarded-proto") === "https",
    path: "/",
    maxAge: SESSION_DAYS * 86_400,
  });
}

export async function destroySession(c: Context) {
  const token = getCookie(c, COOKIE);
  if (token) await db.delete(schema.sessions).where(eq(schema.sessions.tokenHash, sha256(token)));
  deleteCookie(c, COOKIE, { path: "/" });
}

async function currentSession(c: Context) {
  const token = getCookie(c, COOKIE);
  if (!token) return null;
  return (
    (await db.query.sessions.findFirst({
      where: and(eq(schema.sessions.tokenHash, sha256(token)), gt(schema.sessions.expiresAt, Date.now())),
    })) ?? null
  );
}

export async function currentUserId(c: Context): Promise<number | null> {
  return (await currentSession(c))?.userId ?? null;
}

// ---------- App lock ----------
// Enforced here, not just drawn over the page: a locked session gets no data at all (423) until
// the password is entered again, so a refresh or a new tab can't get past it.

async function lockSettings() {
  const rows = await db.select().from(schema.settings).where(inArray(schema.settings.key, ["appLock", "appLockMinutes"]));
  const get = (k: string) => rows.find((r) => r.key === k)?.value;
  return { enabled: get("appLock") === "true", minutes: Number(get("appLockMinutes") ?? 5) || 5 };
}

/** Whether this session is locked right now (idle past the timeout counts, and is saved as locked). */
async function isLocked(session: typeof schema.sessions.$inferSelect) {
  if (session.locked) return true;
  const { enabled, minutes } = await lockSettings();
  if (!enabled || Date.now() - session.lastActiveAt < minutes * 60_000) return false;
  await setLocked(session.tokenHash, true);
  return true;
}

const setLocked = (tokenHash: string, locked: boolean) =>
  db.update(schema.sessions).set({ locked, ...(!locked && { lastActiveAt: Date.now() }) }).where(eq(schema.sessions.tokenHash, tokenHash));

/** For /auth/status: signed in, and locked or not. */
export async function sessionState(c: Context) {
  const session = await currentSession(c);
  return { userId: session?.userId ?? null, locked: session ? await isLocked(session) : false };
}

export async function lockSession(c: Context) {
  const session = await currentSession(c);
  if (session) await setLocked(session.tokenHash, true);
}

/** Unlocks this session (the caller has checked the password). */
export async function unlockSession(c: Context) {
  const session = await currentSession(c);
  if (!session) return false;
  await setLocked(session.tokenHash, false);
  return true;
}

/** You're using Sangam (mouse/keyboard): pushes the auto-lock back. Background refreshes don't count. */
export async function touchSession(c: Context) {
  const session = await currentSession(c);
  if (session && !session.locked) await db.update(schema.sessions).set({ lastActiveAt: Date.now() }).where(eq(schema.sessions.tokenHash, session.tokenHash));
}

export const requireAuth: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const session = await currentSession(c);
  if (!session) return c.json({ error: "Not signed in" }, 401);
  if (await isLocked(session)) return c.json({ error: "Sangam is locked", locked: true }, 423);
  c.set("userId", session.userId);
  await next();
};

// Simple in-memory brute-force guard: 5 failed logins per 15 minutes.
const failures: number[] = [];
const WINDOW_MS = 15 * 60_000;

export function loginBlocked() {
  while (failures.length && failures[0]! < Date.now() - WINDOW_MS) failures.shift();
  return failures.length >= 5;
}

export const recordLoginFailure = () => failures.push(Date.now());
