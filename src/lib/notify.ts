import { BASE, withBase } from "./base";
import { toast } from "sonner";
import { api, type ChannelId, type Conversation, type Settings } from "./relay";

/** One line of plain text, at most `max` characters (with "…"), for notifications. */
export const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};

export type Alert = { convoId: number; name: string; channel: string; subject: string | null; text: string; icon?: string | undefined };

/** Heading = who + where; body = email subject and/or a short preview, never the whole message. */
const heading = (a: Alert) => clip(`${a.name} · ${a.channel}`, 60);
const preview = (a: Alert, max: number) => clip([a.subject, a.text].filter(Boolean).join(" — "), max);

export const desktopSupported = () => typeof window !== "undefined" && "Notification" in window;
export const desktopPermission = () => (desktopSupported() ? Notification.permission : "denied");

/** Asks the browser for permission; resolves true when desktop notifications can be shown. */
export async function requestDesktop() {
  if (!desktopSupported()) return false;
  if (Notification.permission === "granted") return true;
  return (await Notification.requestPermission()) === "granted";
}

// While push is on, the service worker shows system notifications (also with no tab open),
// so the page only shows its own pop-ups while you're looking at it.
let pushActive = false;
export const pushSupported = () => desktopSupported() && "serviceWorker" in navigator && "PushManager" in window;

const keyBytes = (base64url: string) => Uint8Array.from(atob(base64url.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

/**
 * Keeps this browser's push subscription in line with the setting: subscribes (and re-registers
 * with the server, in case its copy was lost) when on, unsubscribes when off.
 */
export async function syncPush(enabled: boolean) {
  if (!pushSupported()) return (pushActive = false);
  const reg = await navigator.serviceWorker.register(withBase("sw.js"), { scope: BASE });
  let sub = await reg.pushManager.getSubscription();
  if (!enabled || Notification.permission !== "granted") {
    if (sub) {
      await api("/push/unsubscribe", { method: "POST", body: { endpoint: sub.endpoint } }).catch(() => {});
      await sub.unsubscribe();
    }
    return (pushActive = false);
  }
  if (!sub) {
    const { publicKey } = await api<{ publicKey: string }>("/push/key");
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  }
  await api("/push/subscribe", { method: "POST", body: sub.toJSON() });
  return (pushActive = true);
}

/** Whether you'd actually see an in-page pop-up right now. */
export const pageVisible = () => document.visibilityState === "visible" && document.hasFocus();

/** Which incoming chats notify: not spam, apps you chose, chats you haven't muted, and not the chat you're reading. */
export function shouldNotify(c: Conversation, settings: Pick<Settings, "notifyChannels" | "mutedChats">, activeId: number | null) {
  if (c.folder === "spam" || settings.mutedChats.includes(c.id)) return false;
  // Sangam's own notices (an account stopped working) always notify.
  if (c.channel !== "sangam" && !settings.notifyChannels.includes(c.channel as ChannelId)) return false;
  return !(c.id === activeId && pageVisible());
}

let audio: AudioContext | undefined;
/** A short two-note chime, generated (no sound file to load). */
export function playChime() {
  try {
    audio ??= new AudioContext();
    const now = audio.currentTime;
    for (const [i, freq] of [880, 1320].entries()) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const start = now + i * 0.12;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.18, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.35);
      osc.connect(gain).connect(audio.destination);
      osc.start(start);
      osc.stop(start + 0.4);
    }
  } catch {
    // Browsers block audio until the page has been clicked once; a silent notification is fine.
  }
}

/**
 * Shows a burst of new messages: a system notification when you're in another window or tab
 * (and allowed it), otherwise a pop-up in the page. Many chats at once become one summary.
 */
export function showAlerts(alerts: Alert[], settings: Pick<Settings, "notifyDesktop" | "notifySound">, onOpen: (convoId: number) => void, opts: { test?: boolean } = {}) {
  if (!alerts.length) return;
  // In the background with push on, the service worker's notification is the alert (and makes the sound).
  if (pushActive && !pageVisible() && !opts.test) return;
  if (settings.notifySound) playChime();
  if (opts.test && pushActive) {
    // The real path: the server pushes, the service worker shows it.
    void api("/push/test", { method: "POST" }).catch(() => toast.error("Couldn't send a test push"));
    return;
  }
  // A test shows the system notification even though you're looking at Sangam.
  const desktop = settings.notifyDesktop && desktopPermission() === "granted" && (opts.test || !pageVisible());
  const open = (id: number) => {
    window.focus();
    onOpen(id);
  };

  if (alerts.length > 3) {
    const names = [...new Set(alerts.map((a) => a.name))];
    const title = `${alerts.length} new messages`;
    const body = clip(`From ${names.slice(0, 4).join(", ")}${names.length > 4 ? ` and ${names.length - 4} more` : ""}`, 140);
    if (desktop) {
      const n = new Notification(title, { body, tag: "sangam-summary", icon: withBase("icons/icon-192.png") });
      n.onclick = () => { window.focus(); n.close(); };
    } else toast(title, { description: body });
    return;
  }

  for (const a of alerts) {
    if (desktop) {
      // The tag replaces an older notification from the same chat instead of stacking them.
      const n = new Notification(heading(a), { body: preview(a, 180), tag: `sangam-${a.convoId}`, icon: a.icon ?? withBase("icons/icon-192.png") });
      n.onclick = () => { open(a.convoId); n.close(); };
    } else {
      toast(heading(a), { id: `msg-${a.convoId}`, description: preview(a, 140), action: { label: "Open", onClick: () => open(a.convoId) } });
    }
  }
}
