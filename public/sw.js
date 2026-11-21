// Sangam's service worker: shows new-message notifications pushed by the Sangam server,
// even when no Sangam tab is open (the browser itself must still be running).

// It also makes Sangam installable as an app, with an "isn't running" screen when the Sangam
// server is stopped. Nothing else is cached: chats always come fresh from your own server.

const CACHE = "sangam-shell-v2";
// Everything relative to where Sangam is served ("/" or a sub-path like "/unified-ChatBox/").
const BASE = new URL(self.registration.scope).pathname;
const OFFLINE = [`${BASE}offline.html`, `${BASE}icon.svg`];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(OFFLINE)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Page loads go to the server as usual; only when it can't be reached is the offline screen shown.
self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  event.respondWith(fetch(event.request).catch(() => caches.match(`${BASE}offline.html`)));
});

const sangamWindows = () => self.clients.matchAll({ type: "window", includeUncontrolled: true });

self.addEventListener("push", (event) => {
  const data = event.data ? event.data.json() : null;
  if (!data) return;
  event.waitUntil(
    sangamWindows().then((windows) => {
      // You're looking at Sangam: the page shows its own pop-up there (or stays quiet for the open chat).
      if (data.tag !== "sangam-test" && windows.some((w) => w.focused && w.visibilityState === "visible")) return;
      return self.registration.showNotification(data.title, {
        body: data.body,
        tag: data.tag,
        renotify: true,
        silent: data.silent,
        icon: `${BASE}icons/icon-192.png`,
        badge: `${BASE}favicon.ico`,
        data: { convoId: data.convoId },
      });
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const convoId = event.notification.data?.convoId;
  event.waitUntil(
    sangamWindows().then((windows) => {
      const win = windows[0];
      if (win) {
        if (convoId) win.postMessage({ type: "open-chat", convoId });
        return win.focus();
      }
      return self.clients.openWindow(convoId ? `${BASE}?open=${convoId}` : BASE);
    }),
  );
});
