# Sangam — Every conversation, one inbox

**Sangam** (संगम, *confluence* — where rivers meet) brings WhatsApp, Gmail, your work email and Telegram into a single, fast inbox. Read, reply, search and organise everything from one place, with messages arriving live.

It runs entirely on **your own PC**: your messages and account logins are stored locally, encrypted, and never pass through anyone else's server. It's free — no paid services required.

---

## Contents

1. [Channels](#channels)
2. [Features](#features)
3. [Quick start](#quick-start)
4. [Connecting your accounts](#connecting-your-accounts)
5. [Using Sangam](#using-sangam)
6. [Privacy & security](#privacy--security)
7. [Configuration](#configuration)
8. [How it works](#how-it-works)
9. [Development](#development)
10. [Troubleshooting](#troubleshooting)
11. [Roadmap](#roadmap)

---

## Channels

| Channel | Status | How it connects |
|---|---|---|
| **Gmail** | ✅ Live | Google sign-in (OAuth). New mail checked every 30 seconds |
| **Work Mail** | ✅ Live | Standard IMAP + SMTP — Google Workspace, Zoho, Hostinger, GoDaddy, cPanel hosting, Yahoo, iCloud. Instant delivery via IMAP IDLE |
| **Telegram** | ✅ Live | Your own account (not a bot), via Telegram's user API. Instant, including bots and groups |
| **WhatsApp** | ✅ Live (unofficial) | Linked device, like WhatsApp Web — scan a QR code or enter a pairing code. ⚠️ Not an official API: use a spare number |
| **Microsoft Teams / Microsoft 365 mail** | 🔜 Planned | Needs a dedicated Microsoft connector (Microsoft blocks password sign-in) |

You can connect **several accounts per channel** (e.g. three WhatsApp numbers, two Telegram numbers); every chat is labelled with the account it belongs to.

---

## Features

### Inbox
- **One list for every channel**, sorted by latest activity, with channel and account labels, tags, unread counts and profile photos (Telegram).
- **Live updates** — new messages, edits and deletions appear instantly. A **● Live** badge shows the connection; if it drops, Sangam reconnects by itself and refreshes in the background meanwhile.
- **Two-way read state** — reading a chat in Sangam marks it read on Gmail/Telegram/your mail server, and reading it elsewhere clears it in Sangam.
- **Sidebar views** — All inbox, Starred, Archived, each channel, and each account separately.

### Messaging
- **Reply** on any channel; email replies stay in the original thread.
- **Attachments** — photos preview in the chat (click for full screen), videos and voice notes play inline, other files show as cards with a download button. Send files with **📎**, by **dragging them onto the chat**, or by **pasting** a screenshot (up to 10 files / 25 MB per message). Files are downloaded from the service the first time you open them and kept on your PC; very large files (over 200 MB) stay on the service.
- **New message** (✎ button) — start a conversation from any connected account: an email, or a Telegram message to an @username or phone number.
- **Telegram extras** — clickable bot buttons, bot keyboards, `/command` suggestions, tappable links and commands, edits and deletions synced live.
- **Email** — full HTML emails in a locked-down viewer (no scripts or forms), remote images blocked until you click **Load images** (stops tracking pixels), quoted history trimmed, light design forced so emails with broken dark modes stay readable.

### Organise
- **Star, archive, tag** chats; filter by tag; remove tags from Contact info.
- **Delete** a message, a chat, or clear a chat — **also on the service** if you choose (Telegram delete, optionally for both sides; Gmail and Work Mail → Trash), or **from Sangam only**. Every delete asks first.
- **Multi-select** — touch-and-hold (or press-and-hold / Ctrl+click) to select chats, Shift+click for a range, then mark read/unread, star, archive, tag or delete them together.

### Find
- **Search everything** — names, subjects, tags and every message body.
- **Combinable filters** — Unread, Tags, any mix of channels, plus **Name**, **Message text** and **Date** (Today, Last 7/30 days, or a custom range).
- **Right-click a chat → More from {name}** (everything from that person, across channels) or **Only {account}**.

### Look & feel
- Light and dark themes, four background tones, collapsible sidebar.
- Smooth animations throughout — automatically turned off when Windows' "Animation effects" setting is off.

---

## Quick start

**You need:** [Node.js](https://nodejs.org) **22 or newer** (`node --version` to check). Windows, macOS and Linux all work.

```bash
npm install          # once
npm run start:local  # starts the backend and the web app together
```

Open **http://localhost:8888**. The first visit runs a short setup:

1. **Profile** — your name, email and a **Sangam password** (protects your inbox; asked when you come back).
2. **Channels** — which channels to show (connecting an account later shows its channel automatically).
3. **Theme** — light/dark and background.

Then connect your accounts from **Profile → Connect** (sidebar → your name).

> On first start Sangam creates a `.env` file with `RELAY_MASTER_KEY`, the key that encrypts every stored login. **Keep it private and never share or commit it.** If it's lost, accounts simply need to be connected again.

---

## Connecting your accounts

### Gmail
One-time setup in Google Cloud (free, no billing account needed):

1. Go to [console.cloud.google.com](https://console.cloud.google.com) → create a project (e.g. `Sangam`) → **APIs & Services → Library** → enable the **Gmail API**.
2. **OAuth consent screen** → *External* → add your Gmail as a test user → add the scope `https://www.googleapis.com/auth/gmail.modify` → **Publish app**.
   *Publishing matters: apps left in "Testing" have their logins expire every 7 days.*
3. **Credentials → Create credentials → OAuth client ID** → *Web application* → authorised redirect URI:
   `http://localhost:8888/api/connect/gmail/callback`
4. Put the two values in `.env` (no restart needed):
   ```
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   ```
5. In Sangam: **Profile → Gmail → Connect**. Google will say the app is *unverified* — that's expected for a personal app: **Advanced → Go to Sangam**, and tick the Gmail permission.

Sangam syncs your latest 50 inbox threads (skipping Promotions, Social and Forums, like Gmail's main tabs) and then new mail every 30 seconds. It can read, send, mark read and move to Trash — it **cannot** permanently delete anything.

### Work Mail (IMAP / SMTP)
**Profile → Work Mail → Connect**, enter your email and password, and pick your provider — server settings fill in automatically (or open *Server settings* to enter your own).

- Most providers need an **app password** rather than your normal one (Google Workspace, Zoho with 2FA, Yahoo, iCloud).
- Sangam tests both incoming and outgoing sign-in before saving anything, and always uses an encrypted connection.
- Syncs the last 30 days (up to 50 emails), then new mail instantly. Replies you send are also filed in your Sent folder.
- **Microsoft 365 / Outlook isn't supported yet** — Microsoft blocks password sign-in.

### WhatsApp
> ⚠️ **Read first:** WhatsApp has no official API for personal accounts, so Sangam links the same way WhatsApp Web does (via the open-source Baileys library). WhatsApp may **ban numbers** that use unofficial clients. Link a **spare number** first and keep your main number off it until you're comfortable with the risk.

**Profile → WhatsApp → Connect**, then either:
- **Scan QR code** — on the phone: WhatsApp → **Settings → Linked devices → Link a device** → scan the code Sangam shows; or
- **Phone number** — enter the number, then on the phone choose **Link with phone number instead** and type the 8-character code.

Sangam appears in **Linked devices** as a Windows device; remove it there (or **Disconnect** in Sangam) to unlink. It syncs your 50 most recent chats (last 20 messages each), then everything live — text, photos, videos, voice notes, documents, edits and deletions. To stay low-key it never shows you as online, never sends typing indicators, and only sends read receipts when you open a chat. Link more numbers the same way.

### Telegram
1. Get an **api_id** and **api_hash** at [my.telegram.org](https://my.telegram.org) → *API development tools*, and add them to `.env`:
   ```
   TELEGRAM_API_ID=...
   TELEGRAM_API_HASH=...
   ```
2. **Profile → Telegram → Connect** → your phone number → the code Telegram sends (usually in the Telegram app) → your two-step verification password if you have one.

Sangam signs in like a new device and appears in **Telegram → Settings → Devices** as **"Sangam (this PC)"** — you can end it there anytime. It syncs your 40 most recent chats (private chats, bots and groups; broadcast channels and the Archived folder are skipped), then everything live. Connect a second number the same way.

---

## Using Sangam

| To… | Do this |
|---|---|
| Open a chat | Click it |
| Send | Type and press **Enter** (**Shift+Enter** for a new line) |
| Attach files | **📎**, drag & drop onto the chat, or paste (Ctrl+V); ✕ removes one before sending |
| View an image full screen | Click it (**Esc** closes) |
| Start a new conversation | **✎** at the top of the inbox (**Ctrl+Enter** sends) |
| Message or chat actions | **Right-click** a message bubble or a chat |
| Select several chats | **Touch-and-hold** / press-and-hold, or **Ctrl+click**; **Shift+click** for a range; **Esc** to stop |
| Combine filters | Click several chips (e.g. **Unread** + **Gmail**); **All** clears them |
| Filter by name, text or date | The **sliders** button inside the search box |
| Everything from one person | Right-click a chat → **More from …** |
| Use a Telegram bot | Tap its buttons, or type **/** for its commands |
| See remote images in an email | **Load images** on the email |
| Switch theme | Sun/moon icon, or **Settings** |
| Load or remove demo data | **Settings → Data** |
| Run setup again | **Settings → Run setup again** |

---

## Privacy & security

- **Local only.** The backend listens on `127.0.0.1`; nothing on your Wi-Fi or the internet can reach it. Messages live in a SQLite file in `data/`.
- **Encrypted credentials.** Gmail tokens, mail passwords and Telegram sessions are encrypted with AES-256-GCM using your `RELAY_MASTER_KEY`, and never sent to the browser.
- **Your password** is stored as a scrypt hash; sessions use http-only, same-site cookies (also `Secure` when served over HTTPS). Login is rate-limited.
- **Safe attachments.** Files are served from your PC only to your logged-in browser. Only images, audio, video and PDFs open inside the page; everything else (including HTML and SVG, which could carry scripts) is download-only and sandboxed.
- **Safe email viewing.** HTML is sanitised and shown in a sandbox with no scripts; remote images (tracking pixels) blocked by default; links open in a new tab without a referrer.
- **CSRF protection**, input validation on every request, and an audit log of sign-ins, connections and deletions.
- **Disconnecting** an account signs out on the service (revokes the Google token / ends the Telegram session) and deletes its stored messages.
- `.env` and `data/` are git-ignored.

---

## Configuration

All settings live in `.env` in the project folder. The Google and Telegram keys are picked up without a restart; everything else is read when the backend starts.

| Variable | Required | Purpose |
|---|---|---|
| `RELAY_MASTER_KEY` | auto-created | Encrypts stored credentials. Keep secret |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | for Gmail | From your Google Cloud OAuth client |
| `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` | for Telegram | From my.telegram.org |
| `RELAY_API_PORT` | no | Backend port (default `8787`) |
| `RELAY_PUBLIC_URL` | no | Where the browser reaches Sangam (default `http://localhost:8888`); also the OAuth redirect base |
| `RELAY_DB_URL` | no | Database location (default `file:data/relay.db`) |
| `RELAY_ALLOWED_ORIGINS` | no | Allowed browser origins (default `http://localhost:8888,http://127.0.0.1:8888`) |
| `RELAY_IMAP_DEBUG` | no | `1` prints the IMAP conversation (passwords masked) — for diagnosing mail servers |

*(Variables keep their original `RELAY_` prefix so existing setups keep working.)*

---

## How it works

```
 Browser (React UI)  ◄── live events (SSE) ──┐
       │ /api (proxied by Vite)               │
       ▼                                      │
 Node backend (Hono, 127.0.0.1:8787) ─────────┘
   ├─ login, settings, search, filters
   ├─ connectors: Gmail · Work Mail (IMAP/SMTP) · Telegram (MTProto)
   └─ SQLite (Drizzle ORM) — conversations, messages, encrypted credentials
```

Each channel is a **connector** behind one shared interface (sync, send, mark read, delete, compose, bot actions), so the UI never needs to know where a message came from. Connectors keep live connections (Telegram, IMAP IDLE) or poll (Gmail), store everything locally, and emit events that update open pages instantly.

### Tech stack
- **Frontend:** TanStack Start (React 19) · Tailwind CSS v4 · TanStack Query · Motion · lucide icons · DOMPurify
- **Backend:** Node.js · Hono · Drizzle ORM + libSQL (SQLite) · `@googleapis/gmail` · imapflow + nodemailer + mailparser · GramJS (`telegram`)
- **Tests:** Vitest + Testing Library

### Project structure
```text
backend/
├── index.ts              # Server start, safety nets for background errors
├── routes.ts             # API: auth, conversations, messages, search, filters, compose, events
├── routes-connect.ts     # Account connection flows (Gmail OAuth, mail form, Telegram login)
├── auth.ts · crypto.ts   # Sessions, password hashing, credential encryption
├── store.ts · events.ts  # Saving messages, live event bus
├── avatars.ts            # Profile photos in data/avatars
├── attachment-files.ts   # Attachment cache in data/attachments
├── db/                   # Schema and migrations
└── connectors/           # gmail.ts · mail.ts · telegram.ts · demo.ts · mime.ts · registry.ts
src/
├── routes/index.tsx      # App shell: login/setup/inbox, filters, selection
├── components/relay/     # Sidebar, list, thread, dialogs, panels, email viewer, bot UI
├── hooks/use-relay.ts    # Data fetching, live updates, actions
├── lib/relay.ts          # Shared types and API client
└── test/                 # Unit tests
data/                     # Your local database and photos (git-ignored)
PLAN.md                   # Full roadmap and design decisions
```

---

## Development

| Command | What it does |
|---|---|
| `npm run start:local` | Backend + web app with auto-reload (backend restarts on save) |
| `npm run dev:api` / `npm run dev:web` | Run either half on its own |
| `npm test` | Unit tests |
| `npm run typecheck` | Type-check frontend and backend |
| `npm run lint` | Lint |
| `npm run db:generate` | Create a migration after editing `backend/db/schema.ts` (applied automatically on start) |

**Start over:** stop the servers and delete the `data/` folder (keeps `.env`).

**Lovable:** this project is connected to Lovable. Its preview has no backend, so it shows *"Sangam's backend isn't running"* — Sangam is meant to run locally.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| *"Sangam's backend isn't running"* | Start it with `npm run start:local`, then refresh |
| Badge shows **Reconnecting…** for long | The backend may have stopped — check the terminal. Messages still refresh every few seconds meanwhile |
| An error mentions *"try refreshing the page"* | The page was open during an update — press **Ctrl+R** |
| Gmail: *"unverified app"* | Expected for a personal app: **Advanced → Go to Sangam** |
| Gmail disconnects after a week | Publish the OAuth consent screen (Quick start → Gmail, step 2), then reconnect |
| Work Mail: wrong password | Use an **app password** from your provider |
| Work Mail fails to connect | Check server names/ports; set `RELAY_IMAP_DEBUG=1` and look at the terminal |
| Telegram: number not found when composing | They only let contacts find them by number — use their @username |
| Times look slightly off | Sync your PC clock: Windows Settings → Time & language → **Sync now** |

---

## Roadmap

- **Notifications** — desktop push while the tab is closed, phone alerts through your own Telegram bot, mute and quiet hours.
- **Microsoft Teams & Microsoft 365 mail** — Microsoft Graph connector.
- **Email Cc / reply-all.**

Details and decisions are in [`PLAN.md`](PLAN.md).
