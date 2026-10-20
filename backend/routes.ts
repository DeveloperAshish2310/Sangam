import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { type AuthEnv, createSession, currentUserId, destroySession, loginBlocked, recordLoginFailure, requireAuth } from "./auth";
import { attachmentBytes, botInfo, compose, deleteConversationRemote, deleteMessagesRemote, disconnectAccount, markRead, pressButton, sendMessage } from "./connectors/registry";
import { loadDemoData, removeDemoData } from "./connectors/demo";
import { hashPassword, verifyPassword } from "./crypto";
import { audit, db, schema } from "./db";
import { emit, liveCount, subscribe } from "./events";
import { connectPrivate, connectPublic } from "./routes-connect";
import { readAvatar } from "./avatars";

export const api = new Hono<AuthEnv>();

const parse = async <T extends z.ZodTypeAny>(req: Request, schemaDef: T): Promise<z.infer<T>> => schemaDef.parse(await req.json());

api.onError((error, c) => {
  if (error instanceof z.ZodError) return c.json({ error: "Invalid input", issues: error.issues }, 400);
  if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
  console.error(error);
  return c.json({ error: error.message || "Server error" }, 500);
});

// ---------- Auth (public) ----------

const publicUser = (u: typeof schema.users.$inferSelect) => ({ id: u.id, name: u.name, email: u.email });

api.get("/auth/status", async (c) => {
  const hasUser = !!(await db.query.users.findFirst());
  const userId = await currentUserId(c);
  const user = userId ? await db.query.users.findFirst({ where: eq(schema.users.id, userId) }) : undefined;
  return c.json({ hasUser, user: user ? publicUser(user) : null });
});

api.post("/auth/register", async (c) => {
  // Single-user app: registration only works once, on first setup.
  if (await db.query.users.findFirst()) return c.json({ error: "Sangam is already set up. Sign in instead." }, 409);
  const body = await parse(
    c.req.raw,
    z.object({ name: z.string().trim().min(1).max(80), email: z.string().trim().max(200), password: z.string().min(8).max(200) }),
  );
  const [user] = await db
    .insert(schema.users)
    .values({ name: body.name, email: body.email, passwordHash: await hashPassword(body.password) })
    .returning();
  await createSession(c, user!.id);
  await audit("register");
  return c.json({ user: publicUser(user!) });
});

api.post("/auth/login", async (c) => {
  if (loginBlocked()) return c.json({ error: "Too many attempts. Try again in 15 minutes." }, 429);
  const { password } = await parse(c.req.raw, z.object({ password: z.string().max(200) }));
  const user = await db.query.users.findFirst();
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    recordLoginFailure();
    await audit("login_failed");
    return c.json({ error: "Wrong password" }, 401);
  }
  await createSession(c, user.id);
  await audit("login");
  return c.json({ user: publicUser(user) });
});

api.post("/auth/logout", async (c) => {
  await destroySession(c);
  return c.json({ ok: true });
});

// ---------- Everything below needs a session ----------

// OAuth callbacks authenticate with their one-time state instead of the session cookie.
api.route("/connect", connectPublic);

api.use("*", requireAuth);

api.route("/connect", connectPrivate);

api.patch("/me", async (c) => {
  const body = await parse(c.req.raw, z.object({ name: z.string().trim().min(1).max(80).optional(), email: z.string().trim().max(200).optional() }));
  const [user] = await db.update(schema.users).set(body).where(eq(schema.users.id, c.get("userId"))).returning();
  return c.json({ user: publicUser(user!) });
});

api.get("/settings", async (c) => {
  const rows = await db.select().from(schema.settings);
  return c.json(Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value) as unknown])));
});

api.put("/settings", async (c) => {
  const body = await parse(c.req.raw, z.record(z.string().max(64), z.unknown()));
  for (const [key, value] of Object.entries(body)) {
    await db
      .insert(schema.settings)
      .values({ key, value: JSON.stringify(value) })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value: JSON.stringify(value) } });
  }
  return c.json({ ok: true });
});

api.get("/accounts", async (c) => {
  // Explicit column list: credentials and sync state never leave the server.
  const rows = await db
    .select({
      id: schema.accounts.id,
      channel: schema.accounts.channel,
      displayName: schema.accounts.displayName,
      status: schema.accounts.status,
      statusMessage: schema.accounts.statusMessage,
    })
    .from(schema.accounts);
  return c.json(rows);
});

api.delete("/accounts/:id", async (c) => {
  await disconnectAccount(idParam(c));
  await audit("account_disconnected", c.req.param("id"));
  return c.json({ ok: true });
});

// ---------- Conversations & messages ----------

api.get("/conversations", async (c) => {
  const convos = await db
    .select()
    .from(schema.conversations)
    .where(eq(schema.conversations.hidden, false))
    .orderBy(desc(schema.conversations.lastMessageAt));
  const last = await db.all<{ conversation_id: number; direction: "in" | "out"; text: string; sent_at: number }>(sql`
    SELECT conversation_id, direction, text, sent_at FROM (
      SELECT m.*, ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY sent_at DESC, id DESC) AS rn
      FROM messages m WHERE hidden = 0
    ) WHERE rn = 1`);
  const lastBy = new Map(last.map((m) => [m.conversation_id, m]));
  return c.json(
    convos.map(({ meta: _connectorState, ...v }) => {
      const m = lastBy.get(v.id);
      return { ...v, lastMessage: m ? { direction: m.direction, text: m.text, sentAt: m.sent_at } : null };
    }),
  );
});

/** The :id route parameter as a positive integer, or a 400 (never NaN reaching a query). */
function idParam(c: Context) {
  const id = Number(c.req.param("id"));
  if (!Number.isSafeInteger(id) || id <= 0) throw new HTTPException(400, { message: "Invalid id — try refreshing the page" });
  return id;
}

const convoById = async (id: number) => {
  const convo = await db.query.conversations.findFirst({ where: eq(schema.conversations.id, id) });
  if (!convo) throw new HTTPException(404, { message: "Conversation not found" });
  return convo;
};

api.get("/conversations/:id/messages", async (c) => {
  const id = idParam(c);
  const rows = await db
    .select()
    .from(schema.messages)
    .where(and(eq(schema.messages.conversationId, id), eq(schema.messages.hidden, false)))
    .orderBy(schema.messages.sentAt, schema.messages.id);
  const files = rows.length
    ? await db
        .select({ id: schema.attachments.id, messageId: schema.attachments.messageId, name: schema.attachments.name, mime: schema.attachments.mime, size: schema.attachments.size })
        .from(schema.attachments)
        .where(inArray(schema.attachments.messageId, rows.map((m) => m.id)))
    : [];
  return c.json(
    rows.map((m) => ({
      ...m,
      // Button callback data stays on the server; the page presses buttons by position.
      ...(m.extra?.buttons && { extra: { ...m.extra, buttons: m.extra.buttons.map((row) => row.map(({ data: _data, ...b }) => b)) } }),
      attachments: files.filter((a) => a.messageId === m.id).map(({ messageId: _m, ...a }) => a),
    })),
  );
});

// Shown in the page (img/video/audio/pdf viewer). Anything else — notably HTML and SVG, which can
// carry scripts — is only ever offered as a download.
const INLINE_SAFE = /^(image\/(png|jpeg|gif|webp|avif|bmp)|video\/(mp4|webm|ogg|quicktime)|audio\/[\w.+-]+|application\/pdf)$/;

const MAX_PROXY_BYTES = 200 * 1024 * 1024;

api.get("/attachments/:id", async (c) => {
  const attachment = await db.query.attachments.findFirst({ where: eq(schema.attachments.id, idParam(c)) });
  if (!attachment) throw new HTTPException(404, { message: "Attachment not found" });
  const message = await db.query.messages.findFirst({ where: eq(schema.messages.id, attachment.messageId) });
  if (!message) throw new HTTPException(404, { message: "Attachment not found" });
  // Files are downloaded into memory before being served; huge ones (films in Telegram groups…) stay on the service.
  if (!attachment.cached && (attachment.size ?? 0) > MAX_PROXY_BYTES) {
    throw new HTTPException(413, { message: `This file is too large to open in Sangam (${Math.round((attachment.size ?? 0) / 1024 / 1024)} MB) — open it in the original app` });
  }
  const data = await attachmentBytes(attachment, await convoById(message.conversationId));
  const inline = INLINE_SAFE.test(attachment.mime) && c.req.query("download") === undefined;
  return c.body(new Uint8Array(data), 200, {
    "content-type": inline ? attachment.mime : "application/octet-stream",
    "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
    "content-length": String(data.length),
    "x-content-type-options": "nosniff",
    // Opened directly in a tab, the file can't run anything or reach anything.
    "content-security-policy": "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'",
    "cache-control": "private, max-age=31536000, immutable",
  });
});

api.post("/messages/:id/press", async (c) => {
  const { row, col } = await parse(c.req.raw, z.object({ row: z.number().int().min(0).max(100), col: z.number().int().min(0).max(100) }));
  const message = await db.query.messages.findFirst({ where: eq(schema.messages.id, idParam(c)) });
  if (!message) throw new HTTPException(404, { message: "Message not found" });
  return c.json(await pressButton(await convoById(message.conversationId), message, row, col));
});

api.post("/compose", async (c) => {
  const body = await parse(
    c.req.raw,
    z.object({
      accountId: z.number().int(),
      to: z.string().trim().min(1).max(320),
      subject: z.string().trim().max(300).optional(),
      text: z.string().trim().min(1).max(10_000),
    }),
  );
  const account = await db.query.accounts.findFirst({ where: eq(schema.accounts.id, body.accountId) });
  if (!account || account.status === "demo") throw new HTTPException(404, { message: "Account not found" });
  // Catch typos before anything is sent.
  const email = z.string().email();
  if ((account.channel === "gmail" || account.channel === "mail") && !email.safeParse(body.to).success)
    return c.json({ error: "Enter a valid email address, e.g. name@example.com" }, 400);
  if (account.channel === "telegram" && !/^(@?[a-zA-Z][a-zA-Z0-9_]{3,31}|\+?[\d\s()-]{7,20})$/.test(body.to))
    return c.json({ error: "Enter a Telegram @username, or a phone number with country code" }, 400);
  if (account.channel === "whatsapp" && !/^\+?[\d\s()-]{8,20}$/.test(body.to))
    return c.json({ error: "Enter the WhatsApp number with country code, e.g. +91 98765 43210" }, 400);
  const result = await compose(account.id, { to: body.to, subject: body.subject, text: body.text });
  await audit("compose", `${account.channel}#${account.id}`);
  return c.json(result);
});

api.get("/conversations/:id/bot", async (c) => c.json(await botInfo(await convoById(idParam(c)))));

api.patch("/conversations/:id", async (c) => {
  const id = idParam(c);
  const body = await parse(
    c.req.raw,
    z.object({
      unread: z.number().int().min(0).optional(),
      starred: z.boolean().optional(),
      archived: z.boolean().optional(),
      tags: z.array(z.string().trim().toLowerCase().min(1).max(32)).max(20).optional(),
    }),
  );
  const before = await convoById(id);
  await db.update(schema.conversations).set(body).where(eq(schema.conversations.id, id));
  if (body.unread === 0 && before.unread > 0) await markRead(before);
  emit({ type: "conversation", id });
  return c.json({ ok: true });
});

// "relay" only hides in Sangam; "everywhere" deletes on the provider first, then hides here.
// If the provider refuses, nothing is hidden, so Sangam never pretends something was deleted.
const deleteScope = z.object({ scope: z.enum(["relay", "everywhere"]).default("relay"), forEveryone: z.boolean().default(false) });

api.delete("/conversations/:id", async (c) => {
  const id = idParam(c);
  const { scope, forEveryone } = await parse(c.req.raw, deleteScope);
  if (scope === "everywhere") {
    await deleteConversationRemote(await convoById(id), { forEveryone, keepChat: false });
    await audit("deleted_on_provider", `conversation ${id}${forEveryone ? " (for everyone)" : ""}`);
  }
  await db.update(schema.conversations).set({ hidden: true, unread: 0 }).where(eq(schema.conversations.id, id));
  emit({ type: "conversation", id });
  return c.json({ ok: true });
});

api.post("/conversations/:id/clear", async (c) => {
  const id = idParam(c);
  const { scope, forEveryone } = await parse(c.req.raw, deleteScope);
  if (scope === "everywhere") {
    await deleteConversationRemote(await convoById(id), { forEveryone, keepChat: true });
    await audit("cleared_on_provider", `conversation ${id}${forEveryone ? " (for everyone)" : ""}`);
  }
  await db.update(schema.messages).set({ hidden: true }).where(eq(schema.messages.conversationId, id));
  await db.update(schema.conversations).set({ unread: 0 }).where(eq(schema.conversations.id, id));
  emit({ type: "conversation", id });
  return c.json({ ok: true });
});

// Gmail's limit for a whole email; also a sensible cap for one chat message.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_UPLOAD_FILES = 10;

api.post("/conversations/:id/messages", async (c) => {
  const convo = await convoById(idParam(c));
  // JSON for text-only messages; multipart form (text + files) when attaching.
  if (!(c.req.header("content-type") ?? "").includes("multipart/form-data")) {
    const { text } = await parse(c.req.raw, z.object({ text: z.string().trim().min(1).max(10_000) }));
    return c.json({ id: await sendMessage(convo, text) });
  }
  const form = await c.req.parseBody({ all: true });
  const text = String(form["text"] ?? "").trim().slice(0, 10_000);
  const uploads = [form["files"]].flat().filter((v): v is File => v instanceof File);
  if (!uploads.length && !text) throw new HTTPException(400, { message: "Nothing to send" });
  if (uploads.length > MAX_UPLOAD_FILES) throw new HTTPException(400, { message: `Up to ${MAX_UPLOAD_FILES} files per message` });
  const total = uploads.reduce((n, f) => n + f.size, 0);
  if (total > MAX_UPLOAD_BYTES) throw new HTTPException(413, { message: "Attachments are limited to 25 MB per message" });
  const files = await Promise.all(
    // Path separators and line breaks never make it into a filename.
    uploads.map(async (f) => ({ name: f.name.replace(/[\\/\r\n]/g, "_").slice(0, 200) || "file", mime: f.type || "application/octet-stream", data: Buffer.from(await f.arrayBuffer()) })),
  );
  return c.json({ id: await sendMessage(convo, text, files) });
});

api.delete("/messages/:id", async (c) => {
  const id = idParam(c);
  const { scope, forEveryone } = await parse(c.req.raw, deleteScope);
  if (scope === "everywhere") {
    const message = await db.query.messages.findFirst({ where: eq(schema.messages.id, id) });
    if (!message) throw new HTTPException(404, { message: "Message not found" });
    await deleteMessagesRemote(await convoById(message.conversationId), [message.externalId], { forEveryone });
    await audit("deleted_on_provider", `message ${id}${forEveryone ? " (for everyone)" : ""}`);
  }
  const [row] = await db.update(schema.messages).set({ hidden: true }).where(eq(schema.messages.id, id)).returning();
  if (row) emit({ type: "conversation", id: row.conversationId });
  return c.json({ ok: true });
});

api.get("/avatars/:id", async (c) => {
  const image = await readAvatar(idParam(c));
  if (!image) return c.json({ error: "No photo" }, 404);
  // URLs carry ?v=<version>, so a changed photo gets a new URL and this can cache forever.
  return c.body(new Uint8Array(image), 200, { "content-type": "image/jpeg", "cache-control": "private, max-age=31536000, immutable" });
});

/**
 * Conversations with at least one message matching ALL given conditions: body text contains
 * `body`, and sent within [from, to). Powers the message-text and date filters.
 */
api.get("/message-filter", async (c) => {
  const q = z
    .object({
      body: z.string().trim().max(200).optional(),
      from: z.coerce.number().int().nonnegative().optional(),
      to: z.coerce.number().int().positive().optional(),
    })
    .parse(c.req.query());
  const conditions = [eq(schema.messages.hidden, false)];
  if (q.body) {
    const like = `%${q.body.toLowerCase().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    conditions.push(sql`lower(${schema.messages.text}) LIKE ${like} ESCAPE '\\'`);
  }
  if (q.from !== undefined) conditions.push(sql`${schema.messages.sentAt} >= ${q.from}`);
  if (q.to !== undefined) conditions.push(sql`${schema.messages.sentAt} < ${q.to}`);
  const rows = await db.selectDistinct({ id: schema.messages.conversationId }).from(schema.messages).where(and(...conditions));
  return c.json(rows.map((r) => r.id));
});

api.get("/search", async (c) => {
  const q = (c.req.query("q") ?? "").trim().toLowerCase();
  if (!q) return c.json([]);
  const like = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  const rows = await db.all<{ id: number }>(sql`
    SELECT DISTINCT c.id FROM conversations c
    LEFT JOIN messages m ON m.conversation_id = c.id AND m.hidden = 0
    WHERE c.hidden = 0 AND (
      lower(c.name) LIKE ${like} ESCAPE '\\' OR lower(coalesce(c.subject, '')) LIKE ${like} ESCAPE '\\'
      OR lower(c.tags) LIKE ${like} ESCAPE '\\' OR lower(m.text) LIKE ${like} ESCAPE '\\'
    )`);
  return c.json(rows.map((r) => r.id));
});

// ---------- Demo data ----------

api.post("/demo", async (c) => {
  await loadDemoData();
  return c.json({ ok: true });
});

api.delete("/demo", async (c) => {
  await removeDemoData();
  return c.json({ ok: true });
});

// ---------- Live updates ----------

api.get("/events", (c) =>
  streamSSE(c, async (stream) => {
    const unsubscribe = subscribe((event) => void stream.writeSSE({ data: JSON.stringify(event) }));
    console.log(`[sangam] live page connected (${liveCount()} open)`);
    stream.onAbort(() => {
      unsubscribe();
      console.log(`[sangam] live page disconnected (${liveCount()} open)`);
    });
    // Heartbeat: the browser treats 25s of silence as a dead connection and reconnects.
    while (!stream.aborted) {
      await stream.writeSSE({ event: "ping", data: "" });
      await stream.sleep(10_000);
    }
    unsubscribe();
  }),
);
