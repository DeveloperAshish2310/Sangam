# Running Sangam on your server

Sangam on the home server (`ashishserver`, Ubuntu 24.04) at
**http://192.168.1.101/unified-ChatBox/**:

```
browser ──http──▶ nginx :80 ──▶ /unified-ChatBox/api/*  → Sangam API  127.0.0.1:8787
                             └─▶ /unified-ChatBox/*      → Sangam web  127.0.0.1:8888
```

> **The project lives in `/var/www/html/unified-ChatBox`** (all sites are kept under
> `/var/www/html`). That is only safe because nginx never serves files from it:
> - LAN (`default` server): `include snippets/sangam.conf;` sends *every* `/unified-ChatBox/...`
>   request to Node, so `/unified-ChatBox/.env` just returns the app's HTML.
> - Public (`main` server, `ashishkumar.uno` via cloudflared, root `/var/www/html`) **must** keep
>   `location ^~ /unified-ChatBox { return 404; }`. Without it the tunnel serves `.env`
>   (the key that decrypts every saved login), `data/relay.db` and any zip to the internet.
> - Any new server block whose `root` is `/var/www/html` needs that same 404 line.
> - Never leave a `unified-ChatBox.zip` (or other backup) in `/var/www/html`.

> **Run Sangam in one place only.** Telegram ends a session used from two places at once, and
> WhatsApp logs out the older one. Stop Sangam on the PC before starting it on the server.

---

## 1. Check nothing is served as a plain file (do this first)

```bash
curl -s -o /dev/null -w "%{http_code}\n" -H "Host: ashishkumar.uno" http://127.0.0.1/unified-ChatBox/.env   # must be 404
curl -s http://192.168.1.101/unified-ChatBox/.env | head -c 15                                           # must be <!DOCTYPE html>
```

## 2. Copy the latest code and data from the PC

On the PC, stop `npm run start:local` (Ctrl+C), then from the project folder:

```bash
scp -P 2310 -r backend src public deploy package.json package-lock.json vite.config.ts tsconfig.json ashishserver@192.168.1.101:/var/www/html/unified-ChatBox/
scp -P 2310 -r data .env ashishserver@192.168.1.101:/var/www/html/unified-ChatBox/
```

`.env` holds `RELAY_MASTER_KEY`. The server **must** use the same `.env` as the PC, or every
account would need connecting again.

## 3. Install and build on the server

```bash
cd /var/www/html/unified-ChatBox
rm -rf node_modules .output     # the copied node_modules are Windows builds; they don't run on Linux
npm ci                          # pm2/node come from ashishserver's nvm: run these as ashishserver, not root
SANGAM_BASE=/unified-ChatBox/ npm run build:server
```

## 4. Tell Sangam its address

Add to the end of `/var/www/html/unified-ChatBox/.env` (`nano .env`):

```
RELAY_PUBLIC_URL=http://192.168.1.101/unified-ChatBox
RELAY_ALLOWED_ORIGINS=http://192.168.1.101
```

## 5. Keep it running (pm2)

```bash
npm install -g pm2
npm run start:server     # starts sangam-api + sangam-web, and saves the list
pm2 startup              # prints ONE sudo command: copy-paste and run it (starts Sangam on boot)
pm2 save
```

Check: `pm2 status` (both "online") and `pm2 logs sangam-api` (Telegram/WhatsApp connecting).

## 6. nginx

```bash
sudo cp deploy/nginx-sangam.conf /etc/nginx/snippets/sangam.conf
sudo nano /etc/nginx/sites-enabled/default
```

Inside the `server { ... server_name _; ... }` block, add this line just above
`location / {`:

```nginx
    include snippets/sangam.conf;
```

Then:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

Open **http://192.168.1.101/unified-ChatBox/** and sign in with your Sangam password.

---

## What works over plain `http://192.168.1.101`

Browsers only allow some features on HTTPS (or `localhost`):

| Feature | Over http://192.168.1.101 |
| --- | --- |
| Chats, sending, media, video streaming, search, spam, folders, App lock | ✅ works |
| Desktop notifications, background push, "Install app", copy-to-clipboard | ❌ blocked by the browser |
| Connecting **Gmail** (Google sign-in) | ❌ Google won't redirect to a private IP over http |

**Notifications/install on your own devices** (Chrome, Edge, Android Chrome): open
`chrome://flags/#unsafely-treat-insecure-origin-as-secure`, add `http://192.168.1.101`, enable,
relaunch. Chrome then treats Sangam as secure: notifications, push and Install all work.

**Gmail** needs HTTPS. Easiest without exposing anything to the internet is Tailscale (already on
the server): `sudo tailscale serve --bg --set-path /unified-ChatBox http://127.0.0.1:80/unified-ChatBox`
then use `https://ashishserver.taila9108f.ts.net/unified-ChatBox/` for the Gmail connect step
(add `https://ashishserver.taila9108f.ts.net/unified-ChatBox/api/connect/gmail/callback` as an
authorised redirect URI in Google Cloud Console, set `RELAY_PUBLIC_URL` to that address and
add `https://ashishserver.taila9108f.ts.net` to `RELAY_ALLOWED_ORIGINS`, comma-separated).

---

## Updating later

From the PC, copy the changed code (never `data/` or `.env`), then on the server:

```bash
cd /var/www/html/unified-ChatBox
npm ci                                           # only if package.json changed
SANGAM_BASE=/unified-ChatBox/ npm run build:server
npm run start:server                             # reloads both
```

Database changes (migrations) apply automatically when the API starts.

## Troubleshooting

| Problem | Check |
| --- | --- |
| 502 Bad Gateway | `pm2 status`: are `sangam-web` and `sangam-api` online? `pm2 logs` |
| Blank page / missing styles | built without `SANGAM_BASE=/unified-ChatBox/`: rebuild (step 3) |
| Stuck on "Connecting…" | the `/unified-ChatBox/api/events` block in nginx; `sudo nginx -t` |
| Can't sign in (403) | `RELAY_ALLOWED_ORIGINS` must be the address in the browser bar; `pm2 restart sangam-api` |
| Telegram "session ended" | Sangam ran on the PC and the server at the same time; reconnect Telegram once |
| `.env` downloadable again | the project is back under `/var/www/html`: move it out (step 1) |
