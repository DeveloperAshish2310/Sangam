# Guide: Node project ko `http://192.168.1.101/<folder>/` pe chalana

Ye guide do kaam sikhati hai:

1. **Sangam (unified-ChatBox) ko update karna**: roz ka kaam ([Part A](#part-a-sangam-ko-update-karna))
2. **Koi bhi naya Node project** same tarike se `device-ip/folder-name` pe lagana ([Part B](#part-b-naya-node-project-lagana))

Server: `ssh root@192.168.1.101 -p 2310` (hostname `ashishserver`, Ubuntu, nginx 1.24)

---

## 0. Pehle samjho: tumhara nginx kaise kaam karta hai

Tumhare server pe nginx **do tarike** se sites chalata hai:

| Tarika | Example | Kahan configured | Kaun dekh sakta hai |
| --- | --- | --- | --- |
| **Subdomain** | `photos.ashishkumar.uno` → `127.0.0.1:2283` | `/etc/nginx/sites-available/photos` | Internet (cloudflared tunnel se) |
| **Folder path** | `192.168.1.101/unified-ChatBox/` → `127.0.0.1:8888` | `default` site + `snippets/sangam.conf` | Sirf LAN (ghar ka network) |

Node app **khud port pe chalti hai** (jaise `127.0.0.1:8888`). nginx bas request ko us port tak
**forward (proxy)** karta hai. Isliye isko "reverse proxy" bolte hain:

```
browser ──▶ nginx :80 ──▶ /unified-ChatBox/api/*  → API  127.0.0.1:8787
                      └─▶ /unified-ChatBox/*      → Web  127.0.0.1:8888
```

Important files on server:

| File | Kaam |
| --- | --- |
| `/etc/nginx/sites-available/default` | LAN site (`server_name _;`, root `/var/www/html`). Folder-path wale projects yahan `include` hote hain |
| `/etc/nginx/sites-available/main` | Public site `ashishkumar.uno` (root bhi `/var/www/html`!) |
| `/etc/nginx/snippets/sangam.conf` | Sangam ke proxy rules |
| `/etc/nginx/snippets/proxy-common.conf` | Subdomain sites ke common proxy headers |
| `sites-enabled/*` | `sites-available` ke symlinks. Jo yahan hai wahi chalta hai |

### ⚠️ Sabse important security rule

Projects `/var/www/html` me rakhte ho, aur `ashishkumar.uno` (public, internet pe) ka root bhi
`/var/www/html` hai. Matlab: agar block nahi kiya, to **internet pe koi bhi tumhari `.env`
aur database download kar sakta hai.** (Nov 11 ko yahi hua tha.)

Isliye **har project folder** ke liye `main` site me ye line honi chahiye:

```nginx
location ^~ /unified-ChatBox { return 404; }
```

Aur **kabhi bhi `.zip` / backup `/var/www/html` me mat chhodo.**

---

## Node / pm2 kahan hai (zaroori)

Node aur pm2 **`ashishserver` user ke nvm** me installed hain, root ke paas nahi. Isliye
`root` se `node: command not found` aata hai. Har npm/pm2 command `ashishserver` ban ke chalao:

```bash
ssh root@192.168.1.101 -p 2310
su - ashishserver
cd /var/www/html/unified-ChatBox
node -v        # v24.x aana chahiye
```

> Agar `su - ashishserver` ke baad bhi `node` na mile:
> `export PATH=/home/ashishserver/.nvm/versions/node/v24.20.0/bin:$PATH`

pm2 apps `ashishserver` ke under chalti hain, aur reboot pe `pm2-ashishserver.service` unhe
apne aap start karta hai.

---

## Part A: Sangam ko update karna

PC pe code change kiya, ab server pe lagana hai.

### A1. Code copy karo (PC se)

PC pe **Git Bash** kholo, project folder me jao:

```bash
cd /d/Ashish/Python/fun/unified-ChatBox

tar -czf - --exclude=node_modules --exclude=data --exclude=.env --exclude=.git \
  --exclude=dump --exclude='*.zip' --exclude=.output --exclude=dist . \
| ssh -p 2310 root@192.168.1.101 \
  'cd /var/www/html/unified-ChatBox && su ashishserver -s /bin/bash -c "tar -xzf - --no-same-owner"'
```

Ye sirf **code** bhejta hai. Server ka `data/` (database) aur `.env` (keys) **touch nahi hote**.

> ❌ Kabhi `data/` ya `.env` PC se server pe overwrite mat karna. Server ka database purana ho jayega.

### A2. Build + restart (server pe)

```bash
ssh root@192.168.1.101 -p 2310
su - ashishserver
cd /var/www/html/unified-ChatBox

npm ci                                              # sirf tab, jab package.json badla ho
SANGAM_BASE=/unified-ChatBox/ npm run build:server  # web app build
npm run start:server                                # dono apps reload + pm2 save
```

`SANGAM_BASE=/unified-ChatBox/` **bhoolna mat**. Iske bina page blank aayega (CSS/JS galat
path se load honge).

### A3. Check karo

```bash
pm2 ls                              # sangam-api aur sangam-web dono "online"
pm2 logs sangam-api --lines 30      # errors dekho (Ctrl+C se bahar)
```

Browser: **http://192.168.1.101/unified-ChatBox/**

Database migrations API start hote hi apne aap lag jaati hain.

---

## Part B: Naya Node project lagana

Example: naya project `my-app`, chahiye `http://192.168.1.101/my-app/`

### B1. Free port choose karo

Pehle se use ho rahe ports: `2283, 3000, 3333, 5001, 6800, 8096, 8123, 8787, 8888`.

```bash
ss -ltnp | grep 127.0.0.1      # jo port list me nahi, wo free hai
```

Maan lo: **`5050`**.

### B2. Code server pe daalo

```bash
# PC (Git Bash) se, project folder me:
tar -czf - --exclude=node_modules --exclude=.git --exclude=.env . \
| ssh -p 2310 root@192.168.1.101 'mkdir -p /var/www/html/my-app && chown ashishserver: /var/www/html/my-app && cd /var/www/html/my-app && su ashishserver -s /bin/bash -c "tar -xzf - --no-same-owner"'
```

`.env` alag se bhejo (sirf pehli baar), phir uski permission lock karo:

```bash
scp -P 2310 .env root@192.168.1.101:/var/www/html/my-app/.env
ssh -p 2310 root@192.168.1.101 'chown ashishserver: /var/www/html/my-app/.env && chmod 600 /var/www/html/my-app/.env'
```

> `node_modules` kabhi copy mat karo. Windows wale Linux pe nahi chalte. Server pe `npm ci` karo.

### B3. App ko batao ki wo `/my-app/` ke andar hai ⚠️

**Ye step sabse zyada miss hota hai.** Browser `/my-app/assets/app.js` maangega. Agar app
`/assets/app.js` bana raha hai to page blank/toota aayega.

Do options hain:

**Option 1 (best): App ko base path batao, aur nginx prefix ko as-is bheje**

| Framework | Setting |
| --- | --- |
| Vite (React/Vue) | `vite.config`: `base: "/my-app/"` |
| Next.js | `next.config.js`: `basePath: "/my-app"` |
| Express | routes ko `app.use("/my-app", router)` me mount karo, static bhi `/my-app` pe |
| Nuxt / Nitro | `baseURL: "/my-app/"` |

nginx (prefix **nahi** hatata, `proxy_pass` ke end me koi path nahi):

```nginx
proxy_pass http://127.0.0.1:5050;
```

**Option 2: App ko pata hi nahi, nginx prefix hata de**

Simple API/backends ke liye theek hai (HTML wale apps me links toot sakte hain):

```nginx
proxy_pass http://127.0.0.1:5050/;     # end me "/" = /my-app/ hata ke bhejta hai
```

> **Rule yaad rakho:** `proxy_pass` ke end me `/` (ya koi path) laga hai to nginx `location`
> wala hissa **hata deta** hai. Nahi laga to **poora URL** waise ka waisa jaata hai.
>
> | location | proxy_pass | `/my-app/login` jaata hai as |
> | --- | --- | --- |
> | `/my-app/` | `http://127.0.0.1:5050` | `/my-app/login` |
> | `/my-app/` | `http://127.0.0.1:5050/` | `/login` |
>
> Sangam dono use karta hai: web ke liye Option 1, API ke liye `.../api/` (prefix hata ke).

### B4. Install + build (server pe)

```bash
ssh root@192.168.1.101 -p 2310
su - ashishserver
cd /var/www/html/my-app
npm ci
npm run build          # agar project me build step hai
```

App **sirf `127.0.0.1` pe** sune, `0.0.0.0` pe nahi. Warna koi bhi nginx ko bypass karke
`192.168.1.101:5050` khol lega. Usually `HOST=127.0.0.1 PORT=5050` env se hota hai.

### B5. pm2 se chalao (hamesha chalta rahe, reboot ke baad bhi)

Project me `ecosystem.config.cjs` banao:

```js
module.exports = {
  apps: [
    {
      name: "my-app",
      cwd: __dirname,
      script: "server.js",               // ya ".output/server/index.mjs", "dist/index.js", etc.
      env: { NODE_ENV: "production", HOST: "127.0.0.1", PORT: "5050" },
      restart_delay: 2000,
      time: true,
    },
  ],
};
```

Start + save:

```bash
pm2 start ecosystem.config.cjs
pm2 save               # reboot ke baad bhi chale, isliye zaroori
pm2 ls
curl -I http://127.0.0.1:5050/my-app/     # nginx se pehle, seedha app check
```

`npm start` jaisa script chalana ho to: `pm2 start npm --name my-app -- start`

### B6. nginx snippet banao (root ban ke)

`exit` karke wapas root pe aao. File banao: `nano /etc/nginx/snippets/my-app.conf`

```nginx
# my-app at http://192.168.1.101/my-app/

# /my-app (bina slash) → /my-app/
location = /my-app {
	return 301 /my-app/;
}

# ^~ zaroori hai: isse default site ke .php / static rules is path ko kabhi handle nahi karte,
# to folder ki files (.env etc.) kabhi seedhi serve nahi hongi, sab Node ko jaata hai.
location ^~ /my-app/ {
	proxy_pass http://127.0.0.1:5050;          # Option 1. Option 2 ke liye: http://127.0.0.1:5050/;
	include snippets/proxy-common.conf;        # Host, X-Forwarded-*, websocket headers
	client_max_body_size 30m;                  # uploads ke liye (zarurat ho to badhao)
}
```

**Live updates / SSE stream** (`EventSource`) wala endpoint ho to uske liye alag block,
buffering band:

```nginx
location = /my-app/api/events {
	proxy_pass http://127.0.0.1:5050/my-app/api/events;
	proxy_http_version 1.1;
	proxy_set_header Connection "";
	proxy_set_header Host $host;
	proxy_buffering off;
	proxy_cache off;
	proxy_read_timeout 24h;
}
```

(WebSocket ke liye kuch extra nahi chahiye. `proxy-common.conf` me `Upgrade` headers already hain.)

### B7. Snippet ko LAN site me jodo

```bash
nano /etc/nginx/sites-available/default
```

`server { ... server_name _; ... }` ke andar, **`location / {` se upar**, ek line daalo:

```nginx
    include snippets/sangam.conf;
    include snippets/my-app.conf;      # ← naya

    location / {
```

### B8. Public site pe block karo ⚠️ (skip mat karna)

```bash
nano /etc/nginx/sites-available/main
```

Sangam wali line ke neeche apne project ki line daalo:

```nginx
    location ^~ /unified-ChatBox { return 404; }
    location ^~ /my-app { return 404; }          # ← naya
```

### B9. Test + reload

Config change karne se pehle backup lo, phir test karo:

```bash
cp /etc/nginx/sites-available/default /root/default.bak-$(date +%F)
cp /etc/nginx/sites-available/main /root/main.bak-$(date +%F)

nginx -t                       # "syntax is ok" + "test is successful" aana chahiye
systemctl reload nginx
```

`nginx -t` fail ho to **reload mat karo**. Error me file + line number hota hai, wo theek karo.

### B10. Final checklist

```bash
# 1) LAN pe site khule → 200
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1/my-app/

# 2) LAN pe .env ki jagah app ka HTML/404 aaye, asli file NAHI
curl -s http://127.0.0.1/my-app/.env | head -c 80

# 3) Public pe 404 → zaroori
curl -s -o /dev/null -w "%{http_code}\n" -H "Host: ashishkumar.uno" http://127.0.0.1/my-app/.env

# 4) Public homepage abhi bhi theek → 200
curl -s -o /dev/null -w "%{http_code}\n" -H "Host: ashishkumar.uno" http://127.0.0.1/
```

PC ke browser me kholo: **http://192.168.1.101/my-app/** ✅

---

## Troubleshooting

| Problem | Kya check karein |
| --- | --- |
| **502 Bad Gateway** | App chal nahi rahi: `su - ashishserver` → `pm2 ls`, `pm2 logs <name>`. Port sahi hai? `ss -ltnp \| grep 5050` |
| **404 nginx wala** | Snippet `include` nahi hua, ya `include` `location / {` ke **neeche** daal diya. `nginx -T \| grep my-app` |
| **Page blank / CSS nahi** | Base path set nahi (B3). Browser DevTools → Network me dekho assets kis URL se aa rahe hain |
| **Links `/login` pe ja rahe, `/my-app/login` pe nahi** | Same: app ko base path pata nahi (B3 Option 1) |
| **"Connecting…" atka / live update nahi** | SSE ke liye `proxy_buffering off` wala block (B6) |
| **Upload fail, 413** | `client_max_body_size` badhao |
| **`node: command not found`** | root se chala rahe ho. `su - ashishserver` karo |
| **Sangam: sign in pe 403** | `.env` me `RELAY_ALLOWED_ORIGINS` = browser bar wala address (`http://192.168.1.101`). Phir `pm2 restart sangam-api` |
| **Sangam: Telegram "session ended"** | PC aur server dono pe ek saath chalaya. Ek hi jagah chalao |
| **Reboot ke baad app band** | `pm2 save` bhool gaye. Chalao: `pm2 save` |
| **nginx -t fail** | Error me file:line hai. Na samjhe to backup wapas: `cp /root/main.bak-DATE /etc/nginx/sites-available/main` |

## Useful commands

```bash
# nginx
nginx -t                          # config test
systemctl reload nginx            # bina downtime config load
nginx -T | less                   # poora final config (saare includes ke saath)
tail -f /var/log/nginx/error.log  # nginx errors live

# pm2 (ashishserver ban ke)
pm2 ls                            # sab apps
pm2 logs sangam-api               # live logs
pm2 restart sangam-web            # ek app restart
pm2 delete my-app && pm2 save     # app hatao

# Ports
ss -ltnp | grep 127.0.0.1         # kaunsa port kaun use kar raha

# Kisne kya download kiya (public site)
grep unified-ChatBox /var/log/nginx/main.access.log | grep -v " 404 "
```

## Yaad rakhne wale 5 rules

1. **App `127.0.0.1` pe sune**, nginx hi ek darwaza hai.
2. **`^~ /folder/` → Node**: is block ke bina nginx folder ki files seedhi serve kar dega.
3. **Har naya folder → `main` site me `return 404`**, warna internet pe `.env` leak.
4. **`/var/www/html` me zip/backup kabhi nahi.**
5. **npm/pm2 hamesha `ashishserver` se**, aur har change ke baad `pm2 save`.
