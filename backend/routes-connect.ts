import { gmail as gmailApi } from "@googleapis/gmail";
import { CodeChallengeMethod } from "google-auth-library";
import { Hono } from "hono";
import type { AuthEnv } from "./auth";
import { encryptJson, newToken } from "./crypto";
import type { ChannelId } from "./db/schema";
import { showChannel } from "./store";
import { audit, db, schema } from "./db";
import { emit } from "./events";
import { startAccount } from "./connectors/registry";
import { GMAIL_SCOPES, gmailConfigured, oauthClient, type GmailCredentials } from "./connectors/gmail";
import { describeMailError, verifyMail, type MailCredentials } from "./connectors/mail";
import { entityName, telegramClient, telegramConfig, type TelegramCredentials } from "./connectors/telegram";
import { Api, type TelegramClient } from "telegram";
import { computeCheck } from "telegram/Password";
import type { Context } from "hono";
import { z } from "zod";
import QRCode from "qrcode";
import { DisconnectReason, jidNormalizedUser, type WASocket } from "baileys";
import { disconnectCode, makeAuthState, makeSocket, type WhatsAppCredentials } from "./connectors/whatsapp";

// One-time OAuth states, bound to a PKCE verifier. The callback arrives as a cross-site
// redirect from Google, where the SameSite=Strict session cookie isn't sent — the
// unguessable state (only issued to a signed-in session) is what authenticates it.
const pending = new Map<string, { verifier: string; expires: number }>();

function takeState(state: string | undefined) {
  for (const [key, value] of pending) if (value.expires < Date.now()) pending.delete(key);
  const entry = state ? pending.get(state) : undefined;
  if (state) pending.delete(state);
  return entry;
}

/** Shared last steps after any channel sign-in succeeds. */
async function accountConnected(id: number, channel: ChannelId, label: string) {
  // A channel you just connected should never be hidden by the channel picker from setup.
  await showChannel(channel);
  await audit("account_connected", `${channel} ${label}`);
  emit({ type: "reset" });
  await startAccount(id);
}

const back = (params: Record<string, string>) => `/?${new URLSearchParams(params).toString()}`;

/** Routes reachable without a session cookie (OAuth callbacks). */
export const connectPublic = new Hono();

connectPublic.get("/gmail/callback", async (c) => {
  const { code, state, error } = c.req.query();
  const entry = takeState(state);
  if (!entry) return c.redirect(back({ connect_error: "That sign-in link expired. Please try connecting again." }));
  if (error || !code) return c.redirect(back({ connect_error: error === "access_denied" ? "Gmail access was not granted." : "Google sign-in failed." }));

  try {
    const auth = oauthClient();
    const { tokens } = await auth.getToken({ code, codeVerifier: entry.verifier });
    if (!tokens.scope?.split(" ").includes(GMAIL_SCOPES[0]!)) {
      return c.redirect(back({ connect_error: "Sangam needs the Gmail permission — tick the Gmail box on Google's consent screen." }));
    }
    if (!tokens.refresh_token) {
      return c.redirect(back({ connect_error: "Google didn't return a long-lived token. Remove Sangam at myaccount.google.com/permissions, then connect again." }));
    }
    auth.setCredentials(tokens);
    const { data: profile } = await gmailApi({ version: "v1", auth }).users.getProfile({ userId: "me" });
    const email = profile.emailAddress!.toLowerCase();
    const credentials = encryptJson({ tokens, email } satisfies GmailCredentials);

    const [account] = await db
      .insert(schema.accounts)
      .values({ channel: "gmail", externalId: email, displayName: email, status: "connected", credentials })
      .onConflictDoUpdate({
        target: [schema.accounts.channel, schema.accounts.externalId],
        set: { credentials, status: "connected", statusMessage: null },
      })
      .returning({ id: schema.accounts.id });
    await accountConnected(account!.id, "gmail", email);
    return c.redirect(back({ connected: "gmail" }));
  } catch (err) {
    console.error("[gmail] connect failed", err);
    return c.redirect(back({ connect_error: "Couldn't finish connecting Gmail. Check the backend log." }));
  }
});

/** Routes that need a signed-in session. */
export const connectPrivate = new Hono<AuthEnv>();

connectPrivate.get("/", (c) =>
  c.json({
    gmail: gmailConfigured() ? { available: true } : { available: false, hint: "Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env" },
    mail: { available: true, form: true },
    whatsapp: { available: true, form: true },
    telegram: telegramConfig() ? { available: true, form: true } : { available: false, hint: "Add TELEGRAM_API_ID and TELEGRAM_API_HASH to .env" },
  }),
);

const server = z.object({ host: z.string().trim().min(3).max(253).regex(/^[a-z0-9.-]+$/i, "Invalid server name"), port: z.number().int().min(1).max(65535), secure: z.boolean() });

// ---------- WhatsApp: link as a device (QR code, or pairing code typed on the phone) ----------

type WaLogin = {
  method: "qr" | "code";
  phone: string;
  auth: ReturnType<typeof makeAuthState>;
  sock: WASocket | null;
  state: "starting" | "qr" | "code" | "connected" | "error";
  qr?: string;
  code?: string;
  error?: string;
  codeRequested: boolean;
  timer: NodeJS.Timeout;
};
const waLogins = new Map<string, WaLogin>();

function endWaLogin(id: string, keepEntry = false) {
  const login = waLogins.get(id);
  if (!login) return;
  clearTimeout(login.timer);
  login.sock?.end(undefined);
  login.sock = null;
  // Keep the final state briefly so the page's next poll can see "connected" / the error.
  if (keepEntry) setTimeout(() => waLogins.delete(id), 60_000);
  else waLogins.delete(id);
}

const failWaLogin = (id: string, error: string) => {
  const login = waLogins.get(id);
  if (!login || login.state === "connected") return;
  login.state = "error";
  login.error = error;
  endWaLogin(id, true);
};

async function finishWaLogin(id: string) {
  const login = waLogins.get(id);
  const user = login?.sock?.user;
  if (!login || !user) return;
  const jid = jidNormalizedUser(user.id);
  const number = jid.split("@")[0]!;
  const credentials = encryptJson({ auth: login.auth.serialize() } satisfies WhatsAppCredentials);
  const displayName = `+${number}${user.name ? ` (${user.name})` : ""}`;
  // The linking socket closes; the connector reopens the session from the saved credentials.
  login.state = "connected";
  endWaLogin(id, true);
  const [account] = await db
    .insert(schema.accounts)
    .values({ channel: "whatsapp", externalId: jid, displayName, status: "connected", credentials })
    .onConflictDoUpdate({ target: [schema.accounts.channel, schema.accounts.externalId], set: { credentials, displayName, status: "connected", statusMessage: null } })
    .returning({ id: schema.accounts.id });
  await accountConnected(account!.id, "whatsapp", jid);
}

function openWaSocket(id: string) {
  const login = waLogins.get(id);
  if (!login) return;
  const sock = makeSocket(login.auth.state);
  login.sock = sock;
  sock.ev.on("connection.update", (update) => {
    void (async () => {
      if (update.qr && login.sock === sock) {
        if (login.method === "qr") {
          login.qr = await QRCode.toDataURL(update.qr, { margin: 1, width: 264 });
          login.state = "qr";
        } else if (!login.codeRequested) {
          // The first QR event means the socket is ready to ask WhatsApp for a pairing code instead.
          login.codeRequested = true;
          login.code = await sock.requestPairingCode(login.phone);
          login.state = "code";
        }
      }
      if (update.connection === "open") await finishWaLogin(id);
      if (update.connection === "close" && login.sock === sock && login.state !== "connected") {
        // WhatsApp always asks for one restart right after the phone approves the link.
        if (disconnectCode(update) === DisconnectReason.restartRequired) openWaSocket(id);
        else failWaLogin(id, "Linking was cancelled or timed out — start again.");
      }
    })().catch((error) => failWaLogin(id, (error as Error)?.message ?? "Linking failed"));
  });
}

connectPrivate.post("/whatsapp/start", async (c) => {
  const body = z
    .object({ method: z.enum(["qr", "code"]), phone: z.string().trim().optional() })
    .parse(await c.req.json());
  const phone = (body.phone ?? "").replace(/\D/g, "");
  if (body.method === "code" && (phone.length < 8 || phone.length > 15)) {
    return c.json({ error: "Enter the WhatsApp number with country code, e.g. +91 98765 43210" }, 400);
  }
  const id = newToken();
  // A link left unfinished is abandoned after 3 minutes.
  const timer = setTimeout(() => failWaLogin(id, "Linking timed out — start again."), 3 * 60_000);
  // Linking state lives only in memory until the phone approves; nothing is saved before that.
  waLogins.set(id, { method: body.method, phone, auth: makeAuthState(null, async () => {}), sock: null, state: "starting", codeRequested: false, timer });
  openWaSocket(id);
  return c.json({ loginId: id });
});

connectPrivate.get("/whatsapp/status/:loginId", (c) => {
  const login = waLogins.get(c.req.param("loginId"));
  if (!login) return c.json({ state: "error", error: "This linking session expired — start again." });
  return c.json({ state: login.state, qr: login.qr ?? null, code: login.code ?? null, error: login.error ?? null });
});

connectPrivate.post("/whatsapp/cancel/:loginId", (c) => {
  endWaLogin(c.req.param("loginId"));
  return c.json({ ok: true });
});

// ---------- Telegram: phone → code → (2FA password) ----------

type TelegramLogin = { client: TelegramClient; phone: string; phoneCodeHash: string; attempts: number; timer: NodeJS.Timeout };
const telegramLogins = new Map<string, TelegramLogin>();

function endTelegramLogin(id: string) {
  const login = telegramLogins.get(id);
  if (!login) return;
  clearTimeout(login.timer);
  telegramLogins.delete(id);
  void login.client.destroy().catch(() => {});
}

function describeTelegramError(error: unknown) {
  const msg = String((error as Error)?.message ?? error);
  const wait = (error as { seconds?: number }).seconds;
  if (wait) return `Telegram asks to wait ${Math.ceil(wait / 60)} minute(s) before trying again.`;
  if (/PHONE_NUMBER_INVALID/.test(msg)) return "That phone number isn't valid. Include the country code, e.g. +91…";
  if (/PHONE_NUMBER_BANNED/.test(msg)) return "Telegram has banned this phone number.";
  if (/PHONE_CODE_INVALID/.test(msg)) return "That code isn't right. Check the latest code Telegram sent.";
  if (/PHONE_CODE_EXPIRED/.test(msg)) return "That code expired. Start again to get a new one.";
  if (/PASSWORD_HASH_INVALID/.test(msg)) return "Wrong two-step verification password.";
  return msg;
}

async function finishTelegramLogin(c: Context, id: string, login: TelegramLogin, user: Api.User) {
  const session = login.client.session.save() as unknown as string;
  // Close the login connection before the connector opens its own with the same key.
  endTelegramLogin(id);
  const credentials = encryptJson({ session } satisfies TelegramCredentials);
  const displayName = user.username ? `@${user.username}` : `${entityName(user)}${user.phone ? ` (+${user.phone})` : ""}`;
  const [account] = await db
    .insert(schema.accounts)
    .values({ channel: "telegram", externalId: user.id.toString(), displayName, status: "connected", credentials })
    .onConflictDoUpdate({
      target: [schema.accounts.channel, schema.accounts.externalId],
      set: { credentials, displayName, status: "connected", statusMessage: null },
    })
    .returning({ id: schema.accounts.id });
  await accountConnected(account!.id, "telegram", user.id.toString());
  return c.json({ ok: true });
}

connectPrivate.post("/telegram/start", async (c) => {
  const config = telegramConfig();
  if (!config) return c.json({ error: "Add TELEGRAM_API_ID and TELEGRAM_API_HASH to .env first." }, 400);
  const { phone } = z.object({ phone: z.string().trim().regex(/^\+?[\d\s()-]{7,20}$/, "Enter your number with country code, e.g. +91 98765 43210") }).parse(await c.req.json());
  const normalized = `+${phone.replace(/\D/g, "")}`;
  const client = telegramClient();
  try {
    await client.connect();
    const { phoneCodeHash, isCodeViaApp } = await client.sendCode(config, normalized);
    const id = newToken();
    // A login left half-finished is dropped after 10 minutes.
    const timer = setTimeout(() => endTelegramLogin(id), 10 * 60_000);
    telegramLogins.set(id, { client, phone: normalized, phoneCodeHash, attempts: 0, timer });
    return c.json({ loginId: id, viaApp: isCodeViaApp });
  } catch (error) {
    await client.destroy().catch(() => {});
    return c.json({ error: describeTelegramError(error) }, 400);
  }
});

connectPrivate.post("/telegram/code", async (c) => {
  const { loginId, code } = z.object({ loginId: z.string(), code: z.string().trim().regex(/^\d{4,8}$/, "Enter the digits Telegram sent") }).parse(await c.req.json());
  const login = telegramLogins.get(loginId);
  if (!login) return c.json({ error: "This sign-in expired. Start again." }, 410);
  if (++login.attempts > 5) {
    endTelegramLogin(loginId);
    return c.json({ error: "Too many attempts. Start again." }, 429);
  }
  try {
    const result = await login.client.invoke(new Api.auth.SignIn({ phoneNumber: login.phone, phoneCodeHash: login.phoneCodeHash, phoneCode: code }));
    if (result instanceof Api.auth.AuthorizationSignUpRequired) {
      endTelegramLogin(loginId);
      return c.json({ error: "There's no Telegram account for this number." }, 400);
    }
    return finishTelegramLogin(c, loginId, login, result.user as Api.User);
  } catch (error) {
    if (/SESSION_PASSWORD_NEEDED/.test(String((error as Error)?.message))) {
      const pwd = await login.client.invoke(new Api.account.GetPassword());
      return c.json({ needPassword: true, hint: pwd.hint ?? null });
    }
    return c.json({ error: describeTelegramError(error) }, 400);
  }
});

connectPrivate.post("/telegram/password", async (c) => {
  const { loginId, password } = z.object({ loginId: z.string(), password: z.string().min(1).max(256) }).parse(await c.req.json());
  const login = telegramLogins.get(loginId);
  if (!login) return c.json({ error: "This sign-in expired. Start again." }, 410);
  if (++login.attempts > 5) {
    endTelegramLogin(loginId);
    return c.json({ error: "Too many attempts. Start again." }, 429);
  }
  try {
    // SRP: the password itself never leaves this PC, only a proof derived from it.
    const pwd = await login.client.invoke(new Api.account.GetPassword());
    const result = await login.client.invoke(new Api.auth.CheckPassword({ password: await computeCheck(pwd, password) }));
    if (!(result instanceof Api.auth.Authorization)) return c.json({ error: "Telegram didn't accept the sign-in." }, 400);
    return finishTelegramLogin(c, loginId, login, result.user as Api.User);
  } catch (error) {
    return c.json({ error: describeTelegramError(error) }, 400);
  }
});

connectPrivate.post("/mail", async (c) => {
  const body = z
    .object({ email: z.string().trim().toLowerCase().email(), name: z.string().trim().max(80), password: z.string().min(1).max(500), imap: server, smtp: server })
    .parse(await c.req.json());
  const creds: MailCredentials = { ...body, name: body.name || body.email };
  try {
    await verifyMail(creds);
  } catch (error) {
    await audit("account_connect_failed", `mail ${body.email}`);
    return c.json({ error: describeMailError(error, creds) }, 400);
  }
  const credentials = encryptJson(creds);
  const [account] = await db
    .insert(schema.accounts)
    .values({ channel: "mail", externalId: body.email, displayName: body.email, status: "connected", credentials })
    .onConflictDoUpdate({
      target: [schema.accounts.channel, schema.accounts.externalId],
      set: { credentials, status: "connected", statusMessage: null },
    })
    .returning({ id: schema.accounts.id });
  await accountConnected(account!.id, "mail", body.email);
  return c.json({ ok: true });
});

connectPrivate.get("/gmail/start", async (c) => {
  if (!gmailConfigured()) return c.redirect(back({ connect_error: "Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env first." }));
  const auth = oauthClient();
  const { codeVerifier, codeChallenge } = await auth.generateCodeVerifierAsync();
  const state = newToken();
  pending.set(state, { verifier: codeVerifier, expires: Date.now() + 10 * 60_000 });
  const url = auth.generateAuthUrl({
    access_type: "offline",
    // Always show consent so Google returns a refresh token, even on reconnect.
    prompt: "consent",
    scope: GMAIL_SCOPES,
    state,
    code_challenge_method: CodeChallengeMethod.S256,
    code_challenge: codeChallenge!,
  });
  return c.redirect(url);
});
