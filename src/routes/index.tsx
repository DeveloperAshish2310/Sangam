import { createFileRoute } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Archive, Bell, BellOff, CheckCheck, Eraser, FolderInput, Pencil, ShieldAlert, ShieldCheck, Inbox, MailOpen, Star, Tag, Trash2, ListFilter, UserSearch } from "lucide-react";
import { Toaster, toast } from "sonner";
import { AnimatePresence, MotionConfig } from "motion/react";
import { PopupMenu, type MenuAction } from "@/components/relay/common";
import { showAlerts, syncPush } from "@/lib/notify";
import { ConversationList, dateBounds, NO_FILTERS, type Filters } from "@/components/relay/ConversationList";
import { LoginScreen, SetupWizard, Splash } from "@/components/relay/Onboarding";
import { ComposeDialog } from "@/components/relay/ComposeDialog";
import { ContactDialog, ContactsPanel, draftFor, type ContactDraft } from "@/components/relay/Contacts";
import { askDelete, askDeleteMany, DeleteConfirmHost } from "@/components/relay/ConfirmDelete";
import { MailConnectDialog } from "@/components/relay/MailConnectDialog";
import { TelegramConnectDialog } from "@/components/relay/TelegramConnectDialog";
import { WhatsAppConnectDialog } from "@/components/relay/WhatsAppConnectDialog";
import { ContactPanel, ProfilePanel, SettingsPanel, TagDialog } from "@/components/relay/Panels";
import { isGlobalView, Sidebar, viewAccount, viewFolder, type View } from "@/components/relay/Sidebar";
import { MoveDialog, NameDialog } from "@/components/relay/Folders";
import { LockScreen } from "@/components/relay/LockScreen";
import { SpamNotice } from "@/components/relay/SpamNotice";
import { Thread } from "@/components/relay/Thread";
import {
  keys, useAccounts, useAuth, useConnectors, useContacts, useMessageFilter, useConversations, useLiveUpdates, useRelayActions, useSearch, useSettings, useTabBadge,
} from "@/hooks/use-relay";
import { api, BACKGROUNDS, ch, DEFAULT_SETTINGS, LOCKED_EVENT, SPAM_FOLDER, type Account, type ChannelId, type Conversation, type Settings, type User } from "@/lib/relay";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Sangam — Unified Communication Inbox" },
      { name: "description", content: "Handle WhatsApp, Telegram, Teams, Gmail and email in one clean dashboard." },
      { property: "og:title", content: "Sangam — Unified Communication Inbox" },
      { property: "og:description", content: "Every channel, one inbox. Read and reply from a single place." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: App,
});

function App() {
  const qc = useQueryClient();
  const auth = useAuth();
  const user = auth.data?.user ?? null;
  const locked = !!auth.data?.locked;
  const { settings, isLoading: settingsLoading, update } = useSettings(!!user && !locked);
  const accounts = useAccounts(!!user && !locked);

  // The server said "locked" (idle timeout, "Lock now", another tab): show the lock screen and
  // drop everything loaded from the page's memory (settings stay, for the theme).
  useEffect(() => {
    const onLocked = () => {
      qc.setQueryData(keys.auth, (a: typeof auth.data) => (a ? { ...a, locked: true } : a));
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "auth" && q.queryKey[0] !== "settings" });
    };
    window.addEventListener(LOCKED_EVENT, onLocked);
    return () => window.removeEventListener(LOCKED_EVENT, onLocked);
  }, [qc]);
  // Lifted out of the wizard so it survives the remount that happens right after registering.
  const [setupStep, setSetupStep] = useState(0);

  useApplyTheme(settings ?? DEFAULT_SETTINGS);

  let screen;
  if (auth.isLoading || (user && (settingsLoading || accounts.isLoading))) screen = <Splash />;
  else if (auth.isError) screen = <BackendDown />;
  else if (!user && auth.data?.hasUser) screen = <LoginScreen />;
  else if (user && locked) screen = <LockScreen user={user} />;
  else if (!user || !settings?.setupDone)
    screen = <SetupWizard user={user} settings={settings} accounts={accounts.data ?? []} step={setupStep} onStep={setSetupStep} update={update} />;
  else screen = <Dashboard user={user} settings={settings} update={update} onRerunSetup={() => { setSetupStep(0); update({ setupDone: false }); }} />;

  return (
    // reducedMotion="user": everything animates unless the OS asks for reduced motion.
    <MotionConfig reducedMotion="user">
      {screen}
      <DeleteConfirmHost />
      {/* Toasts stay compact: heading on one line, preview at most two lines, fixed max width. */}
      <Toaster position="bottom-right" theme={settings?.dark ? "dark" : "light"} richColors closeButton visibleToasts={4}
        toastOptions={{ classNames: { toast: "max-w-[356px]", title: "truncate", description: "line-clamp-2 break-words" } }} />
    </MotionConfig>
  );
}

/**
 * App lock while you use Sangam: mouse/keyboard activity is reported (at most every 30 s), and once
 * you've been idle past the timeout the server is asked whether it's locked. The server decides,
 * so a second tab you're actively using keeps both unlocked. Ctrl+Shift+L locks right away.
 */
function useAppLock(enabled: boolean, minutes: number) {
  useEffect(() => {
    if (!enabled) return undefined;
    let lastSent = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => void api("/auth/status").then((s) => { if ((s as { locked?: boolean }).locked) window.dispatchEvent(new Event(LOCKED_EVENT)); }).catch(() => {});
    const arm = () => { clearTimeout(timer); timer = setTimeout(check, minutes * 60_000 + 1_000); };
    const onActivity = () => {
      arm();
      if (Date.now() - lastSent > 30_000) {
        lastSent = Date.now();
        void api("/auth/activity", { method: "POST" }).catch(() => {});
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "l") { e.preventDefault(); lockNow(); }
      else onActivity();
    };
    const events = ["pointerdown", "pointermove", "wheel", "touchstart"] as const;
    for (const ev of events) window.addEventListener(ev, onActivity, { passive: true });
    window.addEventListener("keydown", onKey);
    onActivity();
    return () => {
      clearTimeout(timer);
      for (const ev of events) window.removeEventListener(ev, onActivity);
      window.removeEventListener("keydown", onKey);
    };
  }, [enabled, minutes]);
}

const lockNow = () => void api("/auth/lock", { method: "POST" }).finally(() => window.dispatchEvent(new Event(LOCKED_EVENT)));

function useApplyTheme({ dark, bg }: Settings) {
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    const b = BACKGROUNDS.find((x) => x.id === bg) ?? BACKGROUNDS[0];
    document.body.style.backgroundColor = dark ? b.dark : b.light;
    return () => { document.body.style.backgroundColor = ""; };
  }, [dark, bg]);
}

function BackendDown() {
  return (
    <div className="grid min-h-screen place-items-center bg-background p-6 text-center">
      <div className="max-w-sm">
        <h1 className="text-xl font-semibold">Sangam's backend isn't running</h1>
        <p className="mt-2 text-sm text-muted-foreground">Start everything with <code className="rounded bg-muted px-1.5 py-0.5">npm run start:local</code>, then refresh.</p>
      </div>
    </div>
  );
}

// A deliberately long fake email, to show how notifications stay compact.
const TEST_EMAIL = `Hi Ashish,

Hope you are doing well! As discussed in yesterday's call, I'm sharing the full breakdown of the quarterly numbers below. Revenue grew 18% quarter on quarter, mainly driven by the enterprise plan, while churn dropped to 2.1%. Please review the attached invoices (there are seven of them) and let me know if anything looks off before Friday — the client wants the final presentation by 10 AM, so we need sign-off by Thursday evening at the latest.

Thanks a lot,
Priya`.repeat(3);

/** The real notification path (sound, desktop pop-up if on), with a fake long email. */
const testNotification = (settings: Settings) =>
  showAlerts([{ convoId: -1, name: "Priya Sharma (Test)", channel: "Gmail", subject: "Quarterly report, invoices and the final numbers for the Friday client presentation", text: TEST_EMAIL }],
    settings, () => {}, { test: true });

const isSpam = (c: Conversation) => c.folder === SPAM_FOLDER;

/** A chat matches a lowercase query by its saved contact name, its name on the service, or its number/address. */
function matchesPerson(c: Conversation, q: string) {
  if (!q) return false;
  if ([c.name, c.serviceName, c.handle.email].some((v) => v?.toLowerCase().includes(q))) return true;
  // "+91 98765-43210" finds 919876543210: compare digits only.
  const digits = q.replace(/\D/g, "");
  return digits.length >= 3 && digits.length === q.replace(/[\s+()-]/g, "").length && !!c.handle.phone?.includes(digits);
}

function Dashboard({ user, settings, update, onRerunSetup }: { user: User; settings: Settings; update: (p: Partial<Settings>) => void; onRerunSetup: () => void }) {
  const qc = useQueryClient();
  const { data: convos = [], isLoading } = useConversations(true);
  const { data: accounts = [] } = useAccounts(true);
  const actions = useRelayActions();

  const [view, setView] = useState<View>("all");
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState<number | null>(null);
  const [convoMenu, setConvoMenu] = useState<{ x: number; y: number; id: number } | null>(null);
  const [tagFor, setTagFor] = useState<number[] | null>(null);
  const [moveFor, setMoveFor] = useState<number[] | null>(null);
  const [folderDialog, setFolderDialog] = useState<{ rename?: string } | null>(null);
  const [folderMenu, setFolderMenu] = useState<{ name: string; x: number; y: number } | null>(null);
  const [panel, setPanel] = useState<"profile" | "settings" | "contact" | "contacts" | null>(null);
  const { data: contactList = [] } = useContacts();
  const [contactDraft, setContactDraft] = useState<ContactDraft | null>(null);
  // New message started from a contact: who to, and which channels suit their phone/email.
  const [composeFor, setComposeFor] = useState<{ to: string; prefer: ChannelId[] } | null>(null);
  const [mailForm, setMailForm] = useState<{ email?: string } | null>(null);
  const [telegramForm, setTelegramForm] = useState(false);
  const [whatsappForm, setWhatsappForm] = useState(false);
  const [composing, setComposing] = useState(false);
  // Stable, so the dialog's polling effect doesn't restart on every render.
  const closeWhatsappForm = useCallback(() => setWhatsappForm(false), []);

  const search = useSearch(query);
  const connectors = useConnectors();
  // Clicking a notification opens that chat, wherever you were.
  const openFromNotification = (id: number) => { setPanel(null); changeView("all"); open(id); };
  const openRef = useRef(openFromNotification);
  openRef.current = openFromNotification;
  useLiveUpdates(true, activeId, settings, openFromNotification);
  useAppLock(settings.appLock, settings.appLockMinutes);

  // Push notifications (shown by the service worker) follow the Desktop notifications setting.
  useEffect(() => {
    syncPush(settings.notifyDesktop).catch((e: Error) => console.warn("[sangam] push setup failed:", e.message));
  }, [settings.notifyDesktop]);

  // A clicked push notification: an open tab gets a message; a new tab gets ?open=<chat id>.
  useEffect(() => {
    const onMessage = (e: MessageEvent<{ type?: string; convoId?: number }>) => {
      if (e.data?.type === "open-chat" && e.data.convoId) openRef.current(e.data.convoId);
    };
    navigator.serviceWorker?.addEventListener("message", onMessage);
    return () => navigator.serviceWorker?.removeEventListener("message", onMessage);
  }, []);
  const openParam = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    openParam.current ??= Number(new URLSearchParams(window.location.search).get("open")) || null;
    const id = openParam.current;
    if (!id || !convos.some((c) => c.id === id)) return;
    openParam.current = null;
    window.history.replaceState(null, "", window.location.pathname);
    openRef.current(id);
  }, [convos]);

  // Providers redirect back with ?connected=gmail or ?connect_error=…
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected") as ChannelId | null;
    const error = params.get("connect_error");
    if (!connected && !error) return;
    if (connected) toast.success(`${ch(connected).name} connected — syncing your messages…`);
    if (error) {
      toast.error(error);
      setPanel("profile");
    }
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  // Only channels picked in setup are shown anywhere in the inbox.
  // (The Sangam notice chat always shows.)
  const visible = useMemo(() => convos.filter((c) => c.channel === "sangam" || settings.channels.includes(c.channel)), [convos, settings.channels]);
  const unread = (channel?: ChannelId) => visible.filter((c) => !c.archived && !isSpam(c) && (!channel || c.channel === channel)).reduce((n, c) => n + c.unread, 0);
  const totalUnread = unread();
  useTabBadge(totalUnread);

  const nameQuery = filters.name.trim().toLowerCase();
  const messageMatches = useMessageFilter(filters.body, dateBounds(filters.date));
  const list = useMemo(() => {
    const matches = query.trim() ? new Set(search.data ?? []) : null;
    const q = query.trim().toLowerCase();
    return visible.filter((c) => {
      // Spam shows only spam; every other view leaves it out.
      if (view === "spam") { if (!isSpam(c)) return false; }
      else {
        if (isSpam(c)) return false;
        if (view === "archived" ? !c.archived : c.archived) return false;
        // The Inbox is what isn't filed away; a folder shows only its own chats.
        if (view === "all" && c.folder !== null) return false;
        const folder = viewFolder(view);
        if (folder !== null && c.folder !== folder) return false;
      }
      if (view === "starred" && !c.starred) return false;
      const onlyAccount = viewAccount(view);
      if (onlyAccount !== null) { if (c.accountId !== onlyAccount) return false; }
      else if (!isGlobalView(view) && c.channel !== view) return false;
      if (filters.unread && !c.unread) return false;
      if (filters.tagged && (tagFilter ? !c.tags.includes(tagFilter) : !c.tags.length)) return false;
      if (filters.channels.length && !filters.channels.includes(c.channel)) return false;
      if (nameQuery && !matchesPerson(c, nameQuery)) return false;
      if (messageMatches && !messageMatches.has(c.id)) return false;
      // The server searches messages; saved contact names, numbers and addresses are matched here.
      return !matches || matches.has(c.id) || matchesPerson(c, q);
    });
  }, [visible, view, filters, tagFilter, query, search.data, nameQuery, messageMatches]);

  // Every tag in use, most used first, for the filter row and add-tag suggestions.
  const allTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of visible) for (const t of c.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }, [visible]);
  // A tag filter whose last chat lost the tag falls back to "any tag".
  useEffect(() => {
    if (tagFilter && !allTags.some((t) => t.tag === tagFilter)) setTagFilter(null);
  }, [allTags, tagFilter]);

  // Picking a channel in the sidebar resets a conflicting channel chip, so the list never goes empty by accident.
  const changeView = (v: View) => {
    setView(v);
    // A sidebar channel/account already narrows the list; drop channel chips that could conflict.
    if (!isGlobalView(v)) setFilters((f) => ({ ...f, channels: [] }));
  };

  // Channels connected with more than one account (e.g. two Telegram numbers) label every chat with its account.
  const multiAccounts = useMemo(() => {
    const by: Partial<Record<ChannelId, Account[]>> = {};
    for (const a of accounts) if (a.status !== "demo") (by[a.channel] ??= []).push(a);
    for (const k of Object.keys(by) as ChannelId[]) if (by[k]!.length < 2) delete by[k];
    return by;
  }, [accounts]);
  const accountLabel = (c: Conversation) => (multiAccounts[c.channel] ? (accounts.find((a) => a.id === c.accountId)?.displayName ?? null) : null);
  const accountUnread = (id: number) => visible.filter((c) => !c.archived && !isSpam(c) && c.accountId === id).reduce((n, c) => n + c.unread, 0);
  const folderUnread = (f: string) => visible.filter((c) => !c.archived && c.folder === f).reduce((n, c) => n + c.unread, 0);
  const onlyAccount = viewAccount(view);
  const viewTitle =
    onlyAccount !== null ? (accounts.find((a) => a.id === onlyAccount)?.displayName ?? "Account")
    : view === "all" ? "Inbox" : view === "starred" ? "Starred" : view === "archived" ? "Archived" : view === "spam" ? "Spam"
    : viewFolder(view) ?? ch(view as ChannelId).name;

  const active = convos.find((c) => c.id === activeId) ?? null;
  const accountOf = (accountId: number) => accounts.find((a) => a.id === accountId);
  const hasDemo = accounts.some((a) => a.status === "demo");

  const open = (id: number) => {
    setActiveId(id);
    const c = convos.find((x) => x.id === id);
    if (c?.unread) actions.update.mutate({ id, patch: { unread: 0 } });
  };

  const signOut = async () => {
    await api("/auth/logout", { method: "POST" });
    // Drops every cached inbox query and refetches auth, which shows the login screen.
    await qc.resetQueries();
  };

  const disconnect = async (a: Account) => {
    if (!window.confirm(`Disconnect ${a.displayName}? Sangam signs out of ${ch(a.channel).name} and deletes its stored messages from this PC.`)) return;
    await api(`/accounts/${a.id}`, { method: "DELETE" }).catch((e: Error) => toast.error(e.message));
    setActiveId(null);
  };

  const toggleDemo = async (load: boolean) => {
    await api("/demo", { method: load ? "POST" : "DELETE" }).catch((e: Error) => toast.error(e.message));
    setActiveId(null);
  };

  // ---- Multi-select: long-press / Ctrl+click to start, Shift+click for ranges, Esc to stop ----
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const anchor = useRef<number | null>(null);
  const clearSelection = () => setSelected(new Set());
  const selectedConvos = list.filter((c) => selected.has(c.id));
  const selecting = selectedConvos.length > 0;
  // A new view or filter is a new list; a selection from the old one would act on hidden chats.
  useEffect(clearSelection, [view, filters, tagFilter]);
  useEffect(() => {
    if (!selecting) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") clearSelection(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selecting]);

  const select = (id: number, mode: "toggle" | "range") => {
    // Read the anchor now: the state updater runs later, after anchor.current moves to this id.
    const start = anchor.current;
    setSelected((prev) => {
      const next = new Set(prev);
      const ids = list.map((c) => c.id);
      const from = start === null ? -1 : ids.indexOf(start);
      const to = ids.indexOf(id);
      if (mode === "range" && from >= 0 && to >= 0) {
        for (const x of ids.slice(Math.min(from, to), Math.max(from, to) + 1)) next.add(x);
      } else if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    anchor.current = id;
  };

  const isDemoConvo = (c: Conversation) => accountOf(c.accountId)?.status === "demo";
  const bulkDelete = async () => {
    const targets = selectedConvos;
    const choice = await askDeleteMany(targets, isDemoConvo);
    if (!choice) return;
    clearSelection();
    if (targets.some((c) => c.id === activeId)) setActiveId(null);
    const results = await Promise.allSettled(
      targets.map((c) => api(`/conversations/${c.id}`, { method: "DELETE", body: { scope: isDemoConvo(c) ? "relay" : choice.scope, forEveryone: false } })),
    );
    await qc.invalidateQueries({ queryKey: ["conversations"] });
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed.length) toast.error(`Deleted ${targets.length - failed.length} of ${targets.length}. ${(failed[0]!.reason as Error).message}`);
    else toast.success(`Deleted ${targets.length} chat${targets.length === 1 ? "" : "s"}${choice.scope === "everywhere" ? " there too" : ""}`);
  };

  const allStarred = selecting && selectedConvos.every((c) => c.starred);
  const patchAll = (patch: (c: Conversation) => Parameters<typeof actions.update.mutate>[0]["patch"] | null) => {
    for (const c of selectedConvos) {
      const p = patch(c);
      if (p) actions.update.mutate({ id: c.id, patch: p });
    }
  };
  const bulkActions: MenuAction[] = [
    { icon: CheckCheck, label: "Mark read", fn: () => patchAll((c) => (c.unread ? { unread: 0 } : null)) },
    { icon: MailOpen, label: "Mark unread", fn: () => patchAll((c) => (c.unread ? null : { unread: 1 })) },
    { icon: Star, label: allStarred ? "Unstar" : "Star", fn: () => patchAll(() => ({ starred: !allStarred })) },
    { icon: Archive, label: view === "archived" ? "Unarchive" : "Archive", fn: () => { patchAll(() => ({ archived: view !== "archived" })); clearSelection(); } },
    { icon: Tag, label: "Tag", fn: () => setTagFor(selectedConvos.map((c) => c.id)) },
    { icon: FolderInput, label: "Move", fn: () => setMoveFor(selectedConvos.map((c) => c.id)) },
    selectedConvos.every(isSpam)
      ? { icon: ShieldCheck, label: "Not spam", fn: () => moveTo(selectedConvos, null) }
      : { icon: ShieldAlert, label: "Spam", danger: true, fn: () => moveTo(selectedConvos, SPAM_FOLDER) },
    { icon: Trash2, label: "Delete", danger: true, fn: () => void bulkDelete() },
  ];

  const short = (text: string, max = 22) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

  /** Every chat from this person, across all channels and accounts (via the Name filter, so it can be tweaked). */
  const showFrom = (name: string) => {
    changeView("all");
    setFilters({ ...NO_FILTERS, name });
    setQuery("");
  };

  // ---- Folders, spam and quick tags ----
  const folders = settings.folders;
  const folderLabel = (f: string | null) => (f === null ? "Inbox" : f === SPAM_FOLDER ? "Spam" : f);
  /** Moves chats, with Undo (which also un-teaches the spam filter). */
  const moveTo = (targets: Conversation[], folder: string | null) => {
    const before = targets.filter((c) => c.folder !== folder).map((c) => ({ id: c.id, folder: c.folder, name: c.name }));
    if (!before.length) return;
    for (const b of before) actions.update.mutate({ id: b.id, patch: { folder } });
    clearSelection();
    const what = before.length === 1 ? `“${short(before[0]!.name)}”` : `${before.length} chats`;
    toast(folder === SPAM_FOLDER ? `Marked ${what} as spam` : `Moved ${what} to ${folderLabel(folder)}`, {
      ...(folder === SPAM_FOLDER && { description: "Their next messages go to Spam too" }),
      action: { label: "Undo", onClick: () => { for (const b of before) actions.update.mutate({ id: b.id, patch: { folder: b.folder } }); } },
    });
  };
  const toggleSpam = (targets: Conversation[]) => moveTo(targets, targets.every(isSpam) ? null : SPAM_FOLDER);
  const createFolder = (name: string) => { if (!folders.includes(name)) update({ folders: [...folders, name] }); };
  const folderOp = (body: { action: "rename"; from: string; to: string } | { action: "delete"; name: string }) =>
    api("/folders", { method: "POST", body })
      .then(() => {
        if (body.action === "rename" && view === `folder:${body.from}`) setView(`folder:${body.to}`);
        if (body.action === "delete") {
          if (view === `folder:${body.name}`) setView("all");
          toast(`Deleted folder “${body.name}”`, { description: "Its chats are back in the Inbox" });
        }
      })
      .catch((e: Error) => toast.error(e.message));

  // Number keys 1–9 toggle these tags. Without a saved list, your most-used tags are saved on first use,
  // so a number never jumps to another tag just because counts changed.
  const quickTags = settings.quickTags.length ? settings.quickTags : allTags.slice(0, 9).map((t) => t.tag);
  const quickTag = (targets: Conversation[], n: number) => {
    const tag = quickTags[n - 1];
    if (!tag) return void toast(`No tag on key ${n}`, { id: "quick-tag", description: "Choose quick tags in Settings → Quick tags" });
    if (!settings.quickTags.length) update({ quickTags });
    const remove = targets.every((c) => c.tags.includes(tag));
    for (const c of targets) {
      if (remove) actions.update.mutate({ id: c.id, patch: { tags: c.tags.filter((t) => t !== tag) } });
      else if (!c.tags.includes(tag)) actions.update.mutate({ id: c.id, patch: { tags: [...c.tags, tag] } });
    }
    toast(`${remove ? "Removed" : "Tagged"} “${tag}”${targets.length > 1 ? ` · ${targets.length} chats` : ""}`, { id: "quick-tag" });
  };

  // Keyboard: 1–9 quick tags, V move, ! spam — on the selected chats, or the open one. Never while typing.
  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => {});
  keyHandler.current = (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || moveFor || tagFor || folderDialog) return;
    const el = e.target as HTMLElement | null;
    if (el?.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) return;
    const targets = selecting ? selectedConvos : active ? [active] : [];
    if (!targets.length) return;
    if (/^[1-9]$/.test(e.key)) { e.preventDefault(); quickTag(targets, Number(e.key)); }
    else if (e.key === "v" || e.key === "V") { e.preventDefault(); setMoveFor(targets.map((c) => c.id)); }
    else if (e.key === "!") { e.preventDefault(); toggleSpam(targets); }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyHandler.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const convoActions = (id: number): MenuAction[] => {
    const c = convos.find((x) => x.id === id);
    if (!c) return [];
    const patch = (p: Parameters<typeof actions.update.mutate>[0]["patch"]) => actions.update.mutate({ id, patch: p });
    const account = accountOf(c.accountId);
    return [
      { icon: Inbox, label: "Open chat", fn: () => open(id) },
      // Quick searches from this chat: everything from the same person, or everything on the same account.
      { icon: UserSearch, label: `More from ${short(c.name)}`, fn: () => showFrom(c.name) },
      ...(account && account.status !== "demo"
        ? [{ icon: ListFilter, label: `Only ${short(account.displayName)}`, fn: () => changeView(`account:${account.id}`) }]
        : []),
      { icon: CheckCheck, label: c.unread ? "Mark as read" : "Mark as unread", fn: () => patch({ unread: c.unread ? 0 : 1 }) },
      { icon: Star, label: c.starred ? "Unstar chat" : "Star chat", fn: () => patch({ starred: !c.starred }) },
      { icon: Tag, label: c.tags.length ? "Tags…" : "Add tag", fn: () => setTagFor([id]) },
      { icon: FolderInput, label: "Move to…  (V)", fn: () => setMoveFor([id]) },
      isSpam(c)
        ? { icon: ShieldCheck, label: "Not spam", fn: () => moveTo([c], null) }
        : { icon: ShieldAlert, label: "Mark as spam  (!)", fn: () => moveTo([c], SPAM_FOLDER) },
      settings.mutedChats.includes(id)
        ? { icon: Bell, label: "Unmute notifications", fn: () => update({ mutedChats: settings.mutedChats.filter((m) => m !== id) }) }
        : { icon: BellOff, label: "Mute notifications", fn: () => update({ mutedChats: [...settings.mutedChats, id] }) },
      { icon: Archive, label: c.archived ? "Unarchive" : "Archive", fn: () => { patch({ archived: !c.archived }); if (!c.archived && activeId === id) setActiveId(null); } },
      { icon: Eraser, label: "Clear chat (Sangam only)", fn: () => actions.clearLocal(c) },
      { icon: Trash2, label: "Delete chat", danger: true, fn: () => void askDelete("chat", c, { isDemo: accountOf(c.accountId)?.status === "demo" }).then((choice) => {
        if (!choice) return;
        actions.remove.mutate({ id, choice });
        if (activeId === id) setActiveId(null);
      }) },
    ];
  };

  const tagTargets = tagFor ? convos.filter((c) => tagFor.includes(c.id)) : [];
  const removeTag = (id: number, tag: string) => {
    const c = convos.find((x) => x.id === id);
    if (c?.tags.includes(tag)) actions.update.mutate({ id, patch: { tags: c.tags.filter((t) => t !== tag) } });
  };
  const moveTargets = moveFor ? convos.filter((c) => moveFor.includes(c.id)) : [];

  return (
    <div className={`flex h-screen overflow-hidden bg-background transition-colors ${settings.blurChats ? "privacy-blur" : ""}`}>
      <Sidebar
        user={user} view={view} onView={changeView} collapsed={settings.collapsed} channels={settings.channels}
        connectedCount={accounts.filter((a) => a.status === "connected").length}
        unread={unread} multiAccounts={multiAccounts} accountUnread={accountUnread} archivedCount={visible.filter((c) => c.archived && !isSpam(c)).length}
        spamCount={visible.filter(isSpam).length} folders={folders} folderUnread={folderUnread}
        onNewFolder={() => setFolderDialog({})} onFolderMenu={(name, x, y) => setFolderMenu({ name, x, y })}
        onLock={settings.appLock ? lockNow : undefined}
        onProfile={() => setPanel("profile")} onSettings={() => setPanel("settings")} onContacts={() => setPanel("contacts")}
      />
      <ConversationList
        view={view} viewTitle={viewTitle} accountLabel={accountLabel} list={list} loading={isLoading} totalUnread={totalUnread} channels={settings.channels}
        activeId={activeId} menuConvoId={convoMenu?.id ?? null}
        query={query} onQuery={setQuery} filters={filters} onFilters={setFilters} tags={allTags} tagFilter={tagFilter} onTagFilter={setTagFilter} quickTags={quickTags}
        muted={settings.mutedChats} onRemoveTag={removeTag}
        notice={view === "spam" ? <SpamNotice enabled={settings.spamFilter} onToggle={() => update({ spamFilter: !settings.spamFilter })} /> : null}
        dark={settings.dark} onToggleDark={() => update({ dark: !settings.dark })} onCompose={() => setComposing(true)}
        collapsed={settings.collapsed} onToggleCollapsed={() => update({ collapsed: !settings.collapsed })}
        onOpen={open} onContextMenu={(id, x, y) => setConvoMenu({ id, x, y })}
        selected={selected} onSelect={select} bulkActions={bulkActions}
        onSelectAll={() => setSelected(new Set(list.map((c) => c.id)))} onClearSelection={clearSelection}
      />
      {active ? (
        <Thread key={active.id} convo={active} account={accountOf(active.accountId)}
          onContact={() => setPanel("contact")} onAddTag={() => setTagFor([active.id])} onClosed={() => setActiveId(null)}
          onMove={() => setMoveFor([active.id])} onSpam={() => toggleSpam([active])} />
      ) : (
        <main className="grid flex-1 place-items-center p-6 text-center text-muted-foreground">
          {convos.length ? "Select a conversation" : (
            <div className="max-w-xs">
              <p className="font-medium text-foreground">Your inbox is empty</p>
              <p className="mt-1 text-sm">Channels will appear here as they're connected. Meanwhile you can load demo data from Settings.</p>
            </div>
          )}
        </main>
      )}

      {convoMenu && <PopupMenu x={convoMenu.x} y={convoMenu.y} width={232} actions={convoActions(convoMenu.id)} onClose={() => setConvoMenu(null)} />}
      {folderMenu && (
        <PopupMenu x={folderMenu.x} y={folderMenu.y} width={200} onClose={() => setFolderMenu(null)} actions={[
          { icon: Pencil, label: "Rename folder", fn: () => setFolderDialog({ rename: folderMenu.name }) },
          { icon: Trash2, label: "Delete folder", danger: true, fn: () => void folderOp({ action: "delete", name: folderMenu.name }) },
        ]} />
      )}
      {/* Panels and dialogs animate out as well as in. */}
      <AnimatePresence>
      {moveTargets.length > 0 && (
        <MoveDialog key="move" targets={moveTargets} folders={folders} onClose={() => setMoveFor(null)}
          onMove={(f) => moveTo(moveTargets, f)} onCreate={createFolder} />
      )}
      {folderDialog && (
        <NameDialog key="folder" title={folderDialog.rename ? "Rename folder" : "New folder"} initial={folderDialog.rename ?? ""} taken={folders}
          onClose={() => setFolderDialog(null)}
          onSave={(name) => {
            if (!folderDialog.rename) createFolder(name);
            else if (name !== folderDialog.rename) void folderOp({ action: "rename", from: folderDialog.rename, to: name });
          }} />
      )}
      {tagTargets.length > 0 && (
        <TagDialog key="tag" targets={tagTargets} existing={allTags.map((t) => t.tag)} quickTags={quickTags} onClose={() => setTagFor(null)}
          onAdd={(t) => { for (const c of tagTargets) if (!c.tags.includes(t)) actions.update.mutate({ id: c.id, patch: { tags: [...c.tags, t] } }); }}
          onRemove={(t) => { for (const c of tagTargets) removeTag(c.id, t); }} />
      )}
      {panel === "profile" && (
        <ProfilePanel key="profile" user={user} accounts={accounts} convos={visible} connectors={connectors.data ?? {}}
          onConnectForm={(channel, account) => {
            if (channel === "mail") setMailForm(account ? { email: account.displayName } : {});
            if (channel === "telegram") setTelegramForm(true);
            if (channel === "whatsapp") setWhatsappForm(true);
          }}
          onDisconnect={(a) => void disconnect(a)} onClose={() => setPanel(null)}
          onSettings={() => setPanel("settings")} onSignOut={() => void signOut()} />
      )}
      {composing && <ComposeDialog key="compose" accounts={accounts.filter((a) => a.status !== "demo")} convos={convos} onOpen={open}
        {...(composeFor && { initialTo: composeFor.to, preferChannels: composeFor.prefer })}
        onClose={() => { setComposing(false); setComposeFor(null); }} />}
      {telegramForm && <TelegramConnectDialog key="telegram" onClose={() => setTelegramForm(false)} />}
      {whatsappForm && <WhatsAppConnectDialog key="whatsapp" onClose={closeWhatsappForm} />}
      {mailForm && <MailConnectDialog key="mail" {...(mailForm.email && { initialEmail: mailForm.email })} onClose={() => setMailForm(null)} />}
      {panel === "contact" && active && (
        <ContactPanel key="contact" convo={active} account={accountOf(active.accountId)} onClose={() => setPanel(null)}
          onSaveContact={() => {
            const saved = contactList.find((x) => x.id === active.contactId);
            setContactDraft(saved ? draftFor(saved) : {
              name: active.serviceName ?? active.name,
              phone: active.handle.phone ? `+${active.handle.phone}` : "",
              email: active.handle.email ?? "",
              notes: "",
              conversationId: active.id,
            });
          }}
          onClear={() => void askDelete("clear", active, { isDemo: accountOf(active.accountId)?.status === "demo" }).then((choice) => {
            if (choice) { actions.clear.mutate({ id: active.id, choice }); setPanel(null); }
          })}
          onRemoveTag={(t) => actions.update.mutate({ id: active.id, patch: { tags: active.tags.filter((x) => x !== t) } })}
          onDelete={() => void askDelete("chat", active, { isDemo: accountOf(active.accountId)?.status === "demo" }).then((choice) => {
            if (choice) { actions.remove.mutate({ id: active.id, choice }); setPanel(null); setActiveId(null); }
          })} />
      )}
      {panel === "contacts" && (
        <ContactsPanel key="contacts" convos={convos} onClose={() => setPanel(null)} onEdit={setContactDraft}
          onOpenChat={(id) => { setPanel(null); changeView("all"); open(id); }}
          onMessage={(p) => {
            setPanel(null);
            setComposeFor(p.phone ? { to: `+${p.phone}`, prefer: ["whatsapp", "telegram"] } : { to: p.email ?? "", prefer: ["gmail", "mail"] });
            setComposing(true);
          }} />
      )}
      {contactDraft && <ContactDialog key="contact-dialog" initial={contactDraft} onClose={() => setContactDraft(null)} />}
      {panel === "settings" && (
        <SettingsPanel key="settings" settings={settings} update={update} allTags={allTags.map((t) => t.tag)} onLockNow={lockNow} hasDemo={hasDemo} onDemo={(load) => void toggleDemo(load)}
          onRerunSetup={() => { setPanel(null); onRerunSetup(); }} onSignOut={() => void signOut()} onClose={() => setPanel(null)}
          onTestNotification={() => testNotification(settings)} />
      )}
      </AnimatePresence>
    </div>
  );
}
