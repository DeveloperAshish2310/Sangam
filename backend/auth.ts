import { and, eq, gt, lt } from "drizzle-orm";
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
  await db.insert(schema.sessions).values({ tokenHash: sha256(token), userId, expiresAt });
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

export async function currentUserId(c: Context): Promise<number | null> {
  const token = getCookie(c, COOKIE);
  if (!token) return null;
  const session = await db.query.sessions.findFirst({
    where: and(eq(schema.sessions.tokenHash, sha256(token)), gt(schema.sessions.expiresAt, Date.now())),
  });
  return session?.userId ?? null;
}

export const requireAuth: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const userId = await currentUserId(c);
  if (!userId) return c.json({ error: "Not signed in" }, 401);
  c.set("userId", userId);
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
