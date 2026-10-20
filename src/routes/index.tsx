import { createFileRoute } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Archive, CheckCheck, Inbox, MailOpen, Star, Tag, Trash2, ListFilter, UserSearch } from "lucide-react";
import { Toaster, toast } from "sonner";
import { AnimatePresence, MotionConfig } from "motion/react";
import { PopupMenu, type MenuAction } from "@/components/relay/common";
import { ConversationList, dateBounds, NO_FILTERS, type Filters } from "@/components/relay/ConversationList";
import { LoginScreen, SetupWizard, Splash } from "@/components/relay/Onboarding";
import { ComposeDialog } from "@/components/relay/ComposeDialog";
import { askDelete, askDeleteMany, DeleteConfirmHost } from "@/components/relay/ConfirmDelete";
import { MailConnectDialog } from "@/components/relay/MailConnectDialog";
import { TelegramConnectDialog } from "@/components/relay/TelegramConnectDialog";
import { WhatsAppConnectDialog } from "@/components/relay/WhatsAppConnectDialog";
import { ContactPanel, ProfilePanel, SettingsPanel, TagDialog } from "@/components/relay/Panels";
import { Sidebar, viewAccount, type View } from "@/components/relay/Sidebar";
import { Thread } from "@/components/relay/Thread";
import {
  useAccounts, useAuth, useConnectors, useMessageFilter, useConversations, useLiveUpdates, useRelayActions, useSearch, useSettings, useTabBadge,
} from "@/hooks/use-relay";
import { api, BACKGROUNDS, ch, DEFAULT_SETTINGS, type Account, type ChannelId, type Conversation, type Settings, type User } from "@/lib/relay";

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
  const auth = useAuth();
  const user = auth.data?.user ?? null;
  const { settings, isLoading: settingsLoading, update } = useSettings(!!user);
  const accounts = useAccounts(!!user);
  // Lifted out of the wizard so it survives the remount that happens right after registering.
  const [setupStep, setSetupStep] = useState(0);

  useApplyTheme(settings ?? DEFAULT_SETTINGS);

  let screen;
  if (auth.isLoading || (user && (settingsLoading || accounts.isLoading))) screen = <Splash />;
  else if (auth.isError) screen = <BackendDown />;
  else if (!user && auth.data?.hasUser) screen = <LoginScreen />;
  else if (!user || !settings?.setupDone)
    screen = <SetupWizard user={user} settings={settings} accounts={accounts.data ?? []} step={setupStep} onStep={setSetupStep} update={update} />;
  else screen = <Dashboard user={user} settings={settings} update={update} onRerunSetup={() => { setSetupStep(0); update({ setupDone: false }); }} />;

  return (
    // reducedMotion="user": everything animates unless the OS asks for reduced motion.
    <MotionConfig reducedMotion="user">
      {screen}
      <DeleteConfirmHost />
      <Toaster position="bottom-right" theme={settings?.dark ? "dark" : "light"} richColors closeButton />
    </MotionConfig>
  );
}

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
  const [panel, setPanel] = useState<"profile" | "settings" | "contact" | null>(null);
  const [mailForm, setMailForm] = useState<{ email?: string } | null>(null);
  const [telegramForm, setTelegramForm] = useState(false);
  const [whatsappForm, setWhatsappForm] = useState(false);
  const [composing, setComposing] = useState(false);
  // Stable, so the dialog's polling effect doesn't restart on every render.
  const closeWhatsappForm = useCallback(() => setWhatsappForm(false), []);

  const search = useSearch(query);
  const connectors = useConnectors();
  useLiveUpdates(true, activeId);

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
  const visible = useMemo(() => convos.filter((c) => settings.channels.includes(c.channel)), [convos, settings.channels]);
  const unread = (channel?: ChannelId) => visible.filter((c) => !c.archived && (!channel || c.channel === channel)).reduce((n, c) => n + c.unread, 0);
  const totalUnread = unread();
  useTabBadge(totalUnread);

  const nameQuery = filters.name.trim().toLowerCase();
  const messageMatches = useMessageFilter(filters.body, dateBounds(filters.date));
  const list = useMemo(() => {
    const matches = query.trim() ? new Set(search.data ?? []) : null;
    return visible.filter((c) => {
      if (view === "archived" ? !c.archived : c.archived) return false;
      if (view === "starred" && !c.starred) return false;
      const onlyAccount = viewAccount(view);
      if (onlyAccount !== null) { if (c.accountId !== onlyAccount) return false; }
      else if (view !== "all" && view !== "starred" && view !== "archived" && c.channel !== view) return false;
      if (filters.unread && !c.unread) return false;
      if (filters.tagged && (tagFilter ? !c.tags.includes(tagFilter) : !c.tags.length)) return false;
      if (filters.channels.length && !filters.channels.includes(c.channel)) return false;
      if (nameQuery && !c.name.toLowerCase().includes(nameQuery)) return false;
      if (messageMatches && !messageMatches.has(c.id)) return false;
      return !matches || matches.has(c.id);
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
    if (v !== "all" && v !== "starred" && v !== "archived") setFilters((f) => ({ ...f, channels: [] }));
  };

  // Channels connected with more than one account (e.g. two Telegram numbers) label every chat with its account.
  const multiAccounts = useMemo(() => {
    const by: Partial<Record<ChannelId, Account[]>> = {};
    for (const a of accounts) if (a.status !== "demo") (by[a.channel] ??= []).push(a);
    for (const k of Object.keys(by) as ChannelId[]) if (by[k]!.length < 2) delete by[k];
    return by;
  }, [accounts]);
  const accountLabel = (c: Conversation) => (multiAccounts[c.channel] ? (accounts.find((a) => a.id === c.accountId)?.displayName ?? null) : null);
  const accountUnread = (id: number) => visible.filter((c) => !c.archived && c.accountId === id).reduce((n, c) => n + c.unread, 0);
  const onlyAccount = viewAccount(view);
  const viewTitle =
    onlyAccount !== null ? (accounts.find((a) => a.id === onlyAccount)?.displayName ?? "Account")
    : view === "all" ? "Inbox" : view === "starred" ? "Starred" : view === "archived" ? "Archived" : ch(view as ChannelId).name;

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
    { icon: Trash2, label: "Delete", danger: true, fn: () => void bulkDelete() },
  ];

  const short = (text: string, max = 22) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

  /** Every chat from this person, across all channels and accounts (via the Name filter, so it can be tweaked). */
  const showFrom = (name: string) => {
    changeView("all");
    setFilters({ ...NO_FILTERS, name });
    setQuery("");
  };

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
      { icon: Tag, label: "Add tag", fn: () => setTagFor([id]) },
      { icon: Archive, label: c.archived ? "Unarchive" : "Archive", fn: () => { patch({ archived: !c.archived }); if (!c.archived && activeId === id) setActiveId(null); } },
      { icon: Trash2, label: "Delete chat", danger: true, fn: () => void askDelete("chat", c, { isDemo: accountOf(c.accountId)?.status === "demo" }).then((choice) => {
        if (!choice) return;
        actions.remove.mutate({ id, choice });
        if (activeId === id) setActiveId(null);
      }) },
    ];
  };

  const tagTargets = tagFor ? convos.filter((c) => tagFor.includes(c.id)) : [];

  return (
    <div className="flex h-screen overflow-hidden bg-background transition-colors">
      <Sidebar
        user={user} view={view} onView={changeView} collapsed={settings.collapsed} channels={settings.channels}
        connectedCount={accounts.filter((a) => a.status === "connected").length}
        unread={unread} multiAccounts={multiAccounts} accountUnread={accountUnread} archivedCount={visible.filter((c) => c.archived).length}
        onProfile={() => setPanel("profile")} onSettings={() => setPanel("settings")}
      />
      <ConversationList
        view={view} viewTitle={viewTitle} accountLabel={accountLabel} list={list} loading={isLoading} totalUnread={totalUnread} channels={settings.channels}
        activeId={activeId} menuConvoId={convoMenu?.id ?? null}
        query={query} onQuery={setQuery} filters={filters} onFilters={setFilters} tags={allTags} tagFilter={tagFilter} onTagFilter={setTagFilter}
        dark={settings.dark} onToggleDark={() => update({ dark: !settings.dark })} onCompose={() => setComposing(true)}
        collapsed={settings.collapsed} onToggleCollapsed={() => update({ collapsed: !settings.collapsed })}
        onOpen={open} onContextMenu={(id, x, y) => setConvoMenu({ id, x, y })}
        selected={selected} onSelect={select} bulkActions={bulkActions}
        onSelectAll={() => setSelected(new Set(list.map((c) => c.id)))} onClearSelection={clearSelection}
      />
      {active ? (
        <Thread key={active.id} convo={active} account={accountOf(active.accountId)}
          onContact={() => setPanel("contact")} onAddTag={() => setTagFor([active.id])} onClosed={() => setActiveId(null)} />
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
      {/* Panels and dialogs animate out as well as in. */}
      <AnimatePresence>
      {tagTargets.length > 0 && (
        <TagDialog key="tag" targets={tagTargets} existing={allTags.map((t) => t.tag)} onClose={() => setTagFor(null)}
          onAdd={(t) => { for (const c of tagTargets) if (!c.tags.includes(t)) actions.update.mutate({ id: c.id, patch: { tags: [...c.tags, t] } }); }} />
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
      {composing && <ComposeDialog key="compose" accounts={accounts.filter((a) => a.status !== "demo")} convos={convos} onOpen={open} onClose={() => setComposing(false)} />}
      {telegramForm && <TelegramConnectDialog key="telegram" onClose={() => setTelegramForm(false)} />}
      {whatsappForm && <WhatsAppConnectDialog key="whatsapp" onClose={closeWhatsappForm} />}
      {mailForm && <MailConnectDialog key="mail" {...(mailForm.email && { initialEmail: mailForm.email })} onClose={() => setMailForm(null)} />}
      {panel === "contact" && active && (
        <ContactPanel key="contact" convo={active} account={accountOf(active.accountId)} onClose={() => setPanel(null)}
          onClear={() => void askDelete("clear", active, { isDemo: accountOf(active.accountId)?.status === "demo" }).then((choice) => {
            if (choice) { actions.clear.mutate({ id: active.id, choice }); setPanel(null); }
          })}
          onRemoveTag={(t) => actions.update.mutate({ id: active.id, patch: { tags: active.tags.filter((x) => x !== t) } })}
          onDelete={() => void askDelete("chat", active, { isDemo: accountOf(active.accountId)?.status === "demo" }).then((choice) => {
            if (choice) { actions.remove.mutate({ id: active.id, choice }); setPanel(null); setActiveId(null); }
          })} />
      )}
      {panel === "settings" && (
        <SettingsPanel key="settings" settings={settings} update={update} hasDemo={hasDemo} onDemo={(load) => void toggleDemo(load)}
          onRerunSetup={() => { setPanel(null); onRerunSetup(); }} onSignOut={() => void signOut()} onClose={() => setPanel(null)} />
      )}
      </AnimatePresence>
    </div>
  );
}
