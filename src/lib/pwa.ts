import { useSyncExternalStore } from "react";
import { BASE, withBase } from "./base";

/**
 * Sangam as an installable app (PWA): its own window, Start-menu/taskbar icon and unread badge.
 * The browser offers installing once the page has a manifest and a service worker; Chrome and
 * Edge also let the page show its own "Install" button via `beforeinstallprompt`.
 */

type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

let deferred: InstallPrompt | null = null;
let installed = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

/** Running as the installed app (its own window), not in a browser tab. */
export const isStandalone = () =>
  typeof window !== "undefined" &&
  (window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true);

let started = false;
/** Registers the service worker and listens for the browser's install offer. Safe to call repeatedly. */
export function startPwa() {
  if (started || typeof window === "undefined") return;
  started = true;
  if ("serviceWorker" in navigator) void navigator.serviceWorker.register(withBase("sw.js"), { scope: BASE }).catch(() => {});
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // keep it for our own Install button
    deferred = e as InstallPrompt;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    installed = true;
    notify();
  });
}

export type InstallState = "installed" | "available" | "unavailable";

const state = (): InstallState => (installed || isStandalone() ? "installed" : deferred ? "available" : "unavailable");

export function useInstallState(): InstallState {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    state,
    () => "unavailable",
  );
}

/** Shows the browser's install dialog. Returns true if Sangam was installed. */
export async function installApp() {
  if (!deferred) return false;
  const prompt = deferred;
  deferred = null;
  await prompt.prompt();
  const { outcome } = await prompt.userChoice;
  notify();
  return outcome === "accepted";
}

/** The unread count on the app's taskbar / dock icon (installed app only; ignored elsewhere). */
export function setAppBadge(count: number) {
  const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  if (!nav.setAppBadge) return;
  void (count > 0 ? nav.setAppBadge(count) : nav.clearAppBadge?.())?.catch(() => {});
}
