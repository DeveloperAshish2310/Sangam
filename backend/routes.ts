import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { type AuthEnv, createSession, destroySession, lockSession, loginBlocked, recordLoginFailure, requireAuth, sessionState, touchSession, unlockSession } from "./auth";
import { attachmentBytes, attachmentRange, attachmentThumb, groupMembers, loadOlder, botInfo, compose, refreshAccount, refreshAll, deleteConversationRemote, deleteMessagesRemote, disconnectAccount, markRead, pressButton, sendMessage } from "./connectors/registry";
import { loadDemoData, removeDemoData } from "./connectors/demo";
import { hashPassword, verifyPassword } from "./crypto";
import { audit, db, schema } from "./db";
import { emit, liveCount, subscribe } from "./events";
import { connectPrivate, connectPublic } from "./routes-connect";
import { readAvatar } from "./avatars";
import { jobsSnapshot } from "./jobs";
import { learnSpam, scanInbox, SPAM } from "./spam";
import { addSubscription, pushTest, removeSubscription, vapidKeys } from "./push";
import { contactsByConversation, conversationHandle, normalizeEmail, normalizePhone } from "./contacts";

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
  const { userId, locked } = await sessionState(c);
  const user = userId ? await db.query.users.findFirst({ where: eq(schema.users.id, userId) }) : undefined;
  return c.json({ hasUser, user: user ? publicUser(user) : null, locked });
});

// App lock: unlocking takes the Sangam password (same brute-force limit as signing in).
api.post("/auth/unlock", async (c) => {
  if (loginBlocked()) return c.json({ error: "Too many attempts. Try again in 15 minutes." }, 429);
  const { password } = await parse(c.req.raw, z.object({ password: z.string().max(200) }));
  const user = await db.query.users.findFirst();
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    recordLoginFailure();
    await audit("unlock_failed");
    return c.json({ error: "Wrong password" }, 401);
  }
  if (!(await unlockSession(c))) return c.json({ error: "Not signed in" }, 401);
  return c.json({ ok: true });
});

api.post("/auth/lock", async (c) => {
  await lockSession(c);
  return c.json({ ok: true });
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
  // "_" keys are the server's own (push keys and subscriptions) and never reach the page.
  return c.json(Object.fromEntries(rows.filter((r) => !r.key.startsWith("_")).map((r) => [r.key, JSON.parse(r.value) as unknown])));
});

api.put("/settings", async (c) => {
  const body = await parse(c.req.raw, z.record(z.string().max(64).regex(/^[^_]/, "Reserved setting"), z.unknown()));
  for (const [key, value] of Object.entries(body)) {
    await db
      .insert(schema.settings)
      .values({ key, value: JSON.stringify(value) })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value: JSON.stringify(value) } });
  }
  return c.json({ ok: true });
});

// Mouse/keyboard activity from the page: keeps App lock from kicking in while you're using Sangam.
api.post("/auth/activity", async (c) => {
  await touchSession(c);
  return c.json({ ok: true });
});

// ---------- Spam and folders ----------

api.post("/spam/scan", async (c) => c.json(await scanInbox()));

// Folders are a settings list (so empty ones exist); renaming or deleting one also moves its chats.
api.post("/folders", async (c) => {
  const body = await parse(
    c.req.raw,
    z.discriminatedUnion("action", [
      z.object({ action: z.literal("rename"), from: z.string().min(1).max(40), to: z.string().trim().min(1).max(40) }),
      z.object({ action: z.literal("delete"), name: z.string().min(1).max(40) }),
    ]),
  );
  const row = await db.query.settings.findFirst({ where: eq(schema.settings.key, "folders") });
  const folders = row ? (JSON.parse(row.value) as string[]) : [];
  const from = body.action === "rename" ? body.from : body.name;
  if (from === SPAM) return c.json({ error: "Spam can't be renamed or deleted" }, 400);
  if (body.action === "rename" && (body.to.toLowerCase() === SPAM || folders.includes(body.to))) return c.json({ error: `There's already a folder called “${body.to}”` }, 400);
  const next = body.action === "rename" ? folders.map((f) => (f === from ? body.to : f)) : folders.filter((f) => f !== from);
  const value = JSON.stringify(next);
  await db.insert(schema.settings).values({ key: "folders", value }).onConflictDoUpdate({ target: schema.settings.key, set: { value } });
  // Deleting a folder puts its chats back in the Inbox; nothing is deleted.
  await db.update(schema.conversations).set({ folder: body.action === "rename" ? body.to : null }).where(eq(schema.conversations.folder, from));
  emit({ type: "reset" });
  return c.json({ ok: true, folders: next });
});

// ---------- Jobs: every call to a service is queued per account ----------

api.get("/jobs", (c) => c.json(jobsSnapshot()));

// Refresh returns at once; progress shows up through the jobs list.
api.post("/refresh", (c) => {
  void refreshAll().catch((error: unknown) => console.error("[sangam] refresh failed:", error));
  return c.json({ ok: true });
});

api.post("/accounts/:id/refresh", (c) => {
  void refreshAccount(idParam(c)).catch((error: unknown) => console.error("[sangam] refresh failed:", error));
  return c.json({ ok: true });
});

// ---------- Push notifications (work with no Sangam tab open) ----------

api.get("/push/key", async (c) => c.json({ publicKey: (await vapidKeys()).publicKey }));

const pushSubscription = z.object({ endpoint: z.string().url().max(2000), expirationTime: z.number().nullable().optional(), keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }) });

api.post("/push/subscribe", async (c) => {
  const { endpoint, keys } = await parse(c.req.raw, pushSubscription);
  await addSubscription({ endpoint, keys });
  return c.json({ ok: true });
});

api.post("/push/unsubscribe", async (c) => {
  const { endpoint } = await parse(c.req.raw, z.object({ endpoint: z.string().max(2000) }));
  await removeSubscription(endpoint);
  return c.json({ ok: true });
});

api.post("/push/test", async (c) => {
  await pushTest();
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
    .from(schema.accounts)
    // The built-in Sangam notice account isn't something you connected.
    .where(ne(schema.accounts.channel, "sangam"));
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
  const contactOf = await contactsByConversation(convos);
  return c.json(
    convos.map((convo) => {
      const { meta, ...v } = convo;
      const flags = (meta ?? {}) as { broadcast?: boolean; readOnly?: boolean };
      const m = lastBy.get(v.id);
      const contact = contactOf.get(v.id);
      return {
        ...v,
        lastMessage: m ? { direction: m.direction, text: m.text, sentAt: m.sent_at } : null,
        // A saved contact's name wins over whatever the service calls this chat.
        contactId: contact?.id ?? null,
        contactName: contact?.name ?? null,
        handle: conversationHandle(convo),
        broadcast: !!flags.broadcast,
        readOnly: !!flags.readOnly,
      };
    }),
  );
});

// ---------- Contacts (Sangam's own address book) ----------

const contactBody = z.object({
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().max(30).optional().nullable(),
  email: z.string().trim().max(200).optional().nullable(),
  notes: z.string().max(2000).optional(),
});
const cleanContact = (b: z.infer<typeof contactBody>) => ({
  name: b.name,
  ...(b.phone !== undefined && { phone: normalizePhone(b.phone) }),
  ...(b.email !== undefined && { email: normalizeEmail(b.email) }),
  ...(b.notes !== undefined && { notes: b.notes }),
});

api.get("/contacts", async (c) => {
  const [all, convos] = await Promise.all([
    db.select().from(schema.contacts).orderBy(sql`lower(${schema.contacts.name})`),
    db.select().from(schema.conversations).where(eq(schema.conversations.hidden, false)),
  ]);
  const contactOf = await contactsByConversation(convos);
  return c.json(all.map((p) => ({ ...p, conversationIds: convos.filter((v) => contactOf.get(v.id)?.id === p.id).map((v) => v.id) })));
});

api.post("/contacts", async (c) => {
  const body = await parse(c.req.raw, contactBody.extend({ conversationId: z.number().int().optional() }));
  const [contact] = await db.insert(schema.contacts).values(cleanContact(body)).returning();
  // Saving from a chat ties that chat to the contact even if it has no phone/email to match on.
  if (body.conversationId) {
    await db.insert(schema.contactLinks).values({ conversationId: body.conversationId, contactId: contact!.id })
      .onConflictDoUpdate({ target: schema.contactLinks.conversationId, set: { contactId: contact!.id } });
  }
  emit({ type: "reset" });
  return c.json(contact);
});

api.patch("/contacts/:id", async (c) => {
  const body = await parse(c.req.raw, contactBody);
  const [contact] = await db.update(schema.contacts).set(cleanContact(body)).where(eq(schema.contacts.id, idParam(c))).returning();
  if (!contact) throw new HTTPException(404, { message: "Contact not found" });
  emit({ type: "reset" });
  return c.json(contact);
});

api.delete("/contacts/:id", async (c) => {
  // Only Sangam's address book entry goes; chats and messages stay.
  await db.delete(schema.contacts).where(eq(schema.contacts.id, idParam(c)));
  emit({ type: "reset" });
  return c.json({ ok: true });
});

api.post("/contacts/:id/link", async (c) => {
  const { conversationId } = await parse(c.req.raw, z.object({ conversationId: z.number().int() }));
  await db.insert(schema.contactLinks).values({ conversationId, contactId: idParam(c) })
    .onConflictDoUpdate({ target: schema.contactLinks.conversationId, set: { contactId: idParam(c) } });
  emit({ type: "reset" });
  return c.json({ ok: true });
});

api.delete("/contacts/links/:id", async (c) => {
  await db.delete(schema.contactLinks).where(eq(schema.contactLinks.conversationId, idParam(c)));
  emit({ type: "reset" });
  return c.json({ ok: true });
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
  // Telegram has preview images and can stream videos; other services serve whole files.
  const telegram = (await convoById(id)).channel === "telegram";
  const rows = await db
    .select()
    .from(schema.messages)
    .where(and(eq(schema.messages.conversationId, id), eq(schema.messages.hidden, false)))
    .orderBy(schema.messages.sentAt, schema.messages.id);
  const files = rows.length
    ? await db
        .select({ id: schema.attachments.id, messageId: schema.attachments.messageId, name: schema.attachments.name, mime: schema.attachments.mime, size: schema.attachments.size, ref: schema.attachments.ref })
        .from(schema.attachments)
        .where(inArray(schema.attachments.messageId, rows.map((m) => m.id)))
    : [];
  return c.json(
    rows.map((m) => ({
      ...m,
      // Button callback data stays on the server; the page presses buttons by position.
      ...(m.extra?.buttons && { extra: { ...m.extra, buttons: m.extra.buttons.map((row) => row.map(({ data: _data, ...b }) => b)) } }),
      attachments: files
        .filter((a) => a.messageId === m.id)
        .map(({ messageId: _m, ref, ...a }) => ({
          ...a,
          thumb: telegram && /^(image|video)\//.test(a.mime),
          stream: telegram,
          duration: typeof ref.duration === "number" ? ref.duration : null,
        })),
    })),
  );
});

// Shown in the page (img/video/audio/pdf viewer). Anything else — notably HTML and SVG, which can
// carry scripts — is only ever offered as a download.
const INLINE_SAFE = /^(image\/(png|jpeg|gif|webp|avif|bmp)|video\/(mp4|webm|ogg|quicktime)|audio\/[\w.+-]+|application\/pdf)$/;

const MAX_PROXY_BYTES = 200 * 1024 * 1024;

const attachmentWithConvo = async (c: Context) => {
  const attachment = await db.query.attachments.findFirst({ where: eq(schema.attachments.id, idParam(c)) });
  if (!attachment) throw new HTTPException(404, { message: "Attachment not found" });
  const message = await db.query.messages.findFirst({ where: eq(schema.messages.id, attachment.messageId) });
  if (!message) throw new HTTPException(404, { message: "Attachment not found" });
  return { attachment, convo: await convoById(message.conversationId) };
};

/** "bytes=a-b" -> the range to send (at most `chunk` bytes); null if absent/unparseable, "bad" if unsatisfiable. */
function parseRange(header: string | undefined, total: number, chunk: number) {
  const m = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!m || (!m[1] && !m[2])) return null;
  let start: number;
  let end: number;
  if (!m[1]) {
    start = Math.max(0, total - Number(m[2]));
    end = total - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
  }
  if (start >= total || start > end) return "bad" as const;
  return { start, end: Math.min(end, start + chunk - 1) };
}

// Each streamed piece of a video: big enough for smooth playback, small enough to start fast.
const STREAM_BYTES = 2 * 1024 * 1024;

const mediaHeaders = (mime: string, name: string, inline: boolean) => ({
  "content-type": inline ? mime : "application/octet-stream",
  "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`,
  "accept-ranges": "bytes",
  "x-content-type-options": "nosniff",
  // Opened directly in a tab, the file can't run anything or reach anything.
  "content-security-policy": "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'",
});

// A photo's or video's small preview, so chats show pictures without downloading the files.
api.get("/attachments/:id/thumb", async (c) => {
  const { attachment, convo } = await attachmentWithConvo(c);
  const data = await attachmentThumb(attachment, convo);
  if (!data) throw new HTTPException(404, { message: "No preview" });
  return c.body(new Uint8Array(data), 200, {
    "content-type": "image/jpeg",
    "x-content-type-options": "nosniff",
    "cache-control": "private, max-age=31536000, immutable",
  });
});

api.get("/attachments/:id", async (c) => {
  const { attachment, convo } = await attachmentWithConvo(c);
  const inline = INLINE_SAFE.test(attachment.mime) && c.req.query("download") === undefined;
  const total = attachment.size ?? 0;

  // Videos and audio play while streaming: the player asks for pieces, and each piece comes
  // straight from the service, so nothing is downloaded whole just to start playing.
  if (inline && !attachment.cached && total > 0 && /^(video|audio)\//.test(attachment.mime)) {
    const range = parseRange(c.req.header("range") ?? "bytes=0-", total, STREAM_BYTES);
    if (range === "bad") return c.body(null, 416, { "content-range": `bytes */${total}` });
    const data = range ? await attachmentRange(attachment, convo, range.start, range.end) : null;
    if (range && data) {
      return c.body(new Uint8Array(data), 206, {
        ...mediaHeaders(attachment.mime, attachment.name, true),
        "content-range": `bytes ${range.start}-${range.start + data.length - 1}/${total}`,
        "content-length": String(data.length),
        "cache-control": "private, max-age=3600",
      });
    }
  }

  // Files are downloaded into memory before being served; huge ones (films in Telegram groups…) stay on the service.
  if (!attachment.cached && (attachment.size ?? 0) > MAX_PROXY_BYTES) {
    throw new HTTPException(413, { message: `This file is too large to open in Sangam (${Math.round((attachment.size ?? 0) / 1024 / 1024)} MB) — open it in the original app` });
  }
  const data = await attachmentBytes(attachment, convo);
  // Already on disk: ranges still matter, so the player can seek.
  const range = inline ? parseRange(c.req.header("range"), data.length, data.length) : null;
  if (range === "bad") return c.body(null, 416, { "content-range": `bytes */${data.length}` });
  const body = range ? data.subarray(range.start, range.end + 1) : data;
  return c.body(new Uint8Array(body), range ? 206 : 200, {
    ...mediaHeaders(attachment.mime, attachment.name, inline),
    ...(range && { "content-range": `bytes ${range.start}-${range.end}/${data.length}` }),
    "content-length": String(body.length),
    "cache-control": "private, max-age=31536000, immutable",
  });
});

// Group info → members (fetched live from the service; null for one-to-one chats).
api.get("/conversations/:id/members", async (c) => c.json(await groupMembers(await convoById(idParam(c)))));

// Scrolling up past the stored history fetches older messages from the service.
api.post("/conversations/:id/older", async (c) => c.json(await loadOlder(await convoById(idParam(c)))));

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
      html: z.string().max(50_000).optional(),
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
  const result = await compose(account.id, { to: body.to, subject: body.subject, text: body.text, html: body.html });
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
      // null = Inbox, "spam" = Spam, else one of your folders.
      folder: z.string().trim().min(1).max(40).nullable().optional(),
    }),
  );
  const before = await convoById(id);
  await db.update(schema.conversations).set(body).where(eq(schema.conversations.id, id));
  if (body.unread === 0 && before.unread > 0) await markRead(before);
  // Marking spam / "Not spam" teaches the filter about this sender.
  if (body.folder !== undefined && (body.folder === SPAM) !== (before.folder === SPAM)) await learnSpam(before, body.folder === SPAM);
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
  // The ids come back so "Undo" can bring exactly these messages back.
  const cleared = await db
    .update(schema.messages)
    .set({ hidden: true })
    .where(and(eq(schema.messages.conversationId, id), eq(schema.messages.hidden, false)))
    .returning({ id: schema.messages.id });
  await db.update(schema.conversations).set({ unread: 0 }).where(eq(schema.conversations.id, id));
  emit({ type: "conversation", id });
  return c.json({ ok: true, ids: cleared.map((m) => m.id) });
});

// Undo for "Clear chat (Sangam only)".
api.post("/conversations/:id/restore", async (c) => {
  const id = idParam(c);
  const { ids } = await parse(c.req.raw, z.object({ ids: z.array(z.number().int()).max(100_000) }));
  for (let i = 0; i < ids.length; i += 500) {
    await db
      .update(schema.messages)
      .set({ hidden: false })
      .where(and(eq(schema.messages.conversationId, id), inArray(schema.messages.id, ids.slice(i, i + 500))));
  }
  emit({ type: "conversation", id });
  return c.json({ ok: true });
});

// "Media, links and docs" in Contact info: files and links from the messages still shown.
const URL_IN_TEXT = /https?:\/\/[^\s<>"')\]]+/g;
api.get("/conversations/:id/media", async (c) => {
  const id = idParam(c);
  const files = await db
    .select({ id: schema.attachments.id, name: schema.attachments.name, mime: schema.attachments.mime, size: schema.attachments.size, sentAt: schema.messages.sentAt })
    .from(schema.attachments)
    .innerJoin(schema.messages, eq(schema.attachments.messageId, schema.messages.id))
    .where(and(eq(schema.messages.conversationId, id), eq(schema.messages.hidden, false)))
    .orderBy(desc(schema.messages.sentAt), desc(schema.attachments.id))
    .limit(500);
  const texts = await db
    .select({ id: schema.messages.id, text: schema.messages.text, sentAt: schema.messages.sentAt })
    .from(schema.messages)
    .where(and(eq(schema.messages.conversationId, id), eq(schema.messages.hidden, false), sql`${schema.messages.text} LIKE '%http%'`))
    .orderBy(desc(schema.messages.sentAt))
    .limit(500);
  const seen = new Set<string>();
  const links = texts.flatMap((m) =>
    [...m.text.matchAll(URL_IN_TEXT)]
      .map((u) => u[0].replace(/[.,;:!?]+$/, ""))
      .filter((url) => !seen.has(url) && seen.add(url))
      .map((url) => ({ url, messageId: m.id, sentAt: m.sentAt })),
  );
  const isMedia = (mime: string) => mime.startsWith("image/") || mime.startsWith("video/");
  const thumb = (await convoById(id)).channel === "telegram";
  return c.json({
    media: files.filter((f) => isMedia(f.mime)).map((f) => ({ ...f, thumb })),
    docs: files.filter((f) => !isMedia(f.mime)),
    links: links.slice(0, 300),
  });
});

// Gmail's limit for a whole email; also a sensible cap for one chat message.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_UPLOAD_FILES = 10;

api.post("/conversations/:id/messages", async (c) => {
  const convo = await convoById(idParam(c));
  // JSON for text-only messages; multipart form (text + files) when attaching.
  if (!(c.req.header("content-type") ?? "").includes("multipart/form-data")) {
    const { text, html } = await parse(c.req.raw, z.object({ text: z.string().trim().min(1).max(10_000), html: z.string().max(50_000).optional() }));
    return c.json({ id: await sendMessage(convo, text, [], html) });
  }
  const form = await c.req.parseBody({ all: true });
  const text = String(form["text"] ?? "").trim().slice(0, 10_000);
  const html = typeof form["html"] === "string" && form["html"].length <= 50_000 ? form["html"] : undefined;
  const uploads = [form["files"]].flat().filter((v): v is File => v instanceof File);
  if (!uploads.length && !text) throw new HTTPException(400, { message: "Nothing to send" });
  if (uploads.length > MAX_UPLOAD_FILES) throw new HTTPException(400, { message: `Up to ${MAX_UPLOAD_FILES} files per message` });
  const total = uploads.reduce((n, f) => n + f.size, 0);
  if (total > MAX_UPLOAD_BYTES) throw new HTTPException(413, { message: "Attachments are limited to 25 MB per message" });
  const files = await Promise.all(
    // Path separators and line breaks never make it into a filename.
    uploads.map(async (f) => ({ name: f.name.replace(/[\\/\r\n]/g, "_").slice(0, 200) || "file", mime: f.type || "application/octet-stream", data: Buffer.from(await f.arrayBuffer()) })),
  );
  return c.json({ id: await sendMessage(convo, text, files, text ? html : undefined) });
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
