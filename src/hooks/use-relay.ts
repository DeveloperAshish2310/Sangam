import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import type { DeleteChoice } from "@/components/relay/ConfirmDelete";
import { api, apiForm, ch, DEFAULT_SETTINGS, type Account, type BotInfo, type ChannelId, type Contact, type Conversation, type GroupMembers, type Message, type Settings, type User } from "@/lib/relay";
import { clip, shouldNotify, showAlerts, type Alert } from "@/lib/notify";
import { setAppBadge } from "@/lib/pwa";
import { withBase } from "@/lib/base";
import { avatarUrl } from "@/components/relay/common";

export { clip };

export const keys = {
  auth: ["auth"] as const,
  settings: ["settings"] as const,
  accounts: ["accounts"] as const,
  conversations: ["conversations"] as const,
  messages: (id: number) => ["messages", id] as const,
  search: (q: string) => ["search", q] as const,
  bot: (id: number) => ["bot", id] as const,
  jobs: ["jobs"] as const,
  media: (id: number) => ["media", id] as const,
};

export function useAuth() {
  return useQuery({ queryKey: keys.auth, queryFn: () => api<{ hasUser: boolean; user: User | null; locked: boolean }>("/auth/status") });
}

// Changes not yet confirmed by the server. They're laid over any fetched settings, so a refetch that
// started before the save (live updates refetch everything) can't undo a choice you just made.
let pendingSettings: Partial<Settings> = {};

export function useSettings(enabled: boolean) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: keys.settings,
    queryFn: async () => ({ ...DEFAULT_SETTINGS, ...(await api<Partial<Settings>>("/settings")), ...pendingSettings }),
    enabled,
    // Only this app changes settings, so there's no need to refetch them on every mount or focus.
    staleTime: Infinity,
  });
  const update = (patch: Partial<Settings>) => {
    // Optimistic: theme toggles and "always load images" must take effect instantly.
    pendingSettings = { ...pendingSettings, ...patch };
    void qc.cancelQueries({ queryKey: keys.settings });
    qc.setQueryData<Settings>(keys.settings, (s) => ({ ...(s ?? DEFAULT_SETTINGS), ...patch }));
    api("/settings", { method: "PUT", body: patch })
      .catch((e: Error) => toast.error(e.message))
      .finally(() => {
        for (const key of Object.keys(patch) as (keyof Settings)[]) if (pendingSettings[key] === patch[key]) delete pendingSettings[key];
      });
  };
  return { settings: query.data, isLoading: query.isLoading, update };
}

export function useAccounts(enabled: boolean) {
  return useQuery({ queryKey: keys.accounts, queryFn: () => api<Account[]>("/accounts"), enabled });
}

export function useConnectors() {
  return useQuery({
    queryKey: ["connectors"],
    queryFn: () => api<Partial<Record<ChannelId, { available: boolean; hint?: string; form?: boolean }>>>("/connect"),
  });
}

// ---- Live connection status, shared by every hook that needs it ----

type LiveStatus = "live" | "connecting";
let liveStatus: LiveStatus = "connecting";
const liveListeners = new Set<() => void>();
function setLiveStatus(next: LiveStatus) {
  if (next === liveStatus) return;
  liveStatus = next;
  for (const l of liveListeners) l();
}
export function useLiveStatus() {
  return useSyncExternalStore(
    (l) => (liveListeners.add(l), () => void liveListeners.delete(l)),
    () => liveStatus,
    () => "connecting" as LiveStatus,
  );
}

// After sending, re-check the chat briefly so the reply shows even if the live stream is broken.
let burstUntil = 0;
const POLL_BURST_MS = 20_000;
export const expectReplySoon = () => (burstUntil = Date.now() + POLL_BURST_MS);

export function useContacts(enabled = true) {
  return useQuery({ queryKey: ["contacts"], queryFn: () => api<Contact[]>("/contacts"), enabled });
}

export function useConversations(enabled: boolean) {
  const status = useLiveStatus();
  return useQuery({
    queryKey: keys.conversations,
    // A saved contact's name is shown everywhere instead of the service's name for the chat.
    queryFn: async () =>
      (await api<Conversation[]>("/conversations")).map((c) => (c.contactName ? { ...c, name: c.contactName, serviceName: c.name } : c)),
    enabled,
    // Fallback while the live stream is down; otherwise the stream keeps it fresh.
    refetchInterval: status === "live" ? false : 10_000,
  });
}

export function useMessages(conversationId: number | null) {
  const status = useLiveStatus();
  return useQuery({
    queryKey: keys.messages(conversationId ?? 0),
    queryFn: () => api<Message[]>(`/conversations/${conversationId}/messages`),
    refetchInterval: () => (Date.now() < burstUntil ? 2000 : status === "live" ? false : 5000),
    enabled: !!conversationId,
  });
}

/** Bot commands and keyboard for a conversation (empty for non-bot chats). */
export function useBotInfo(conversationId: number, enabled: boolean) {
  return useQuery({
    queryKey: keys.bot(conversationId),
    queryFn: () => api<BotInfo>(`/conversations/${conversationId}/bot`),
    enabled,
    staleTime: 60_000,
  });
}

/** Ids of conversations with a message matching the body text and date bounds (null when unused). */
export function useMessageFilter(body: string, bounds: { from?: number; to?: number }) {
  const [debounced, setDebounced] = useState(body);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(body.trim()), 250);
    return () => clearTimeout(t);
  }, [body]);
  const params = new URLSearchParams();
  if (debounced) params.set("body", debounced);
  if (bounds.from !== undefined) params.set("from", String(bounds.from));
  if (bounds.to !== undefined) params.set("to", String(bounds.to));
  const qs = params.toString();
  const query = useQuery({
    queryKey: ["message-filter", qs],
    queryFn: () => api<number[]>(`/message-filter?${qs}`),
    enabled: !!qs,
    placeholderData: (prev) => prev,
  });
  return useMemo(() => (qs ? new Set(query.data ?? []) : null), [qs, query.data]);
}

export function useSearch(query: string) {
  const [debounced, setDebounced] = useState(query);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 200);
    return () => clearTimeout(t);
  }, [query]);
  return useQuery({
    queryKey: keys.search(debounced),
    queryFn: () => api<number[]>(`/search?q=${encodeURIComponent(debounced)}`),
    enabled: !!debounced,
    placeholderData: (prev) => prev,
  });
}

export function useRelayActions() {
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: keys.conversations });
  const onError = (e: Error) => toast.error(e.message);
  const patchLocal = (id: number, patch: Partial<Conversation>) =>
    qc.setQueryData<Conversation[]>(keys.conversations, (cs) => cs?.map((c) => (c.id === id ? { ...c, ...patch } : c)));

  const update = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: Partial<Pick<Conversation, "unread" | "starred" | "archived" | "tags" | "folder">> }) =>
      api(`/conversations/${id}`, { method: "PATCH", body: patch }),
    onMutate: ({ id, patch }) => patchLocal(id, patch),
    onError,
    onSettled: refresh,
  });
  // On failure (e.g. the service refused) the refetch in onSettled brings the item back.
  const deletedThere = (choice: DeleteChoice) => { if (choice.scope === "everywhere") toast.success("Deleted there too"); };
  const remove = useMutation({
    mutationFn: ({ id, choice }: { id: number; choice: DeleteChoice }) => api(`/conversations/${id}`, { method: "DELETE", body: choice }),
    onMutate: ({ id }) => qc.setQueryData<Conversation[]>(keys.conversations, (cs) => cs?.filter((c) => c.id !== id)),
    onSuccess: (_d, { choice }) => deletedThere(choice),
    onError,
    onSettled: refresh,
  });
  const clear = useMutation({
    mutationFn: ({ id, choice }: { id: number; choice: DeleteChoice }) => api(`/conversations/${id}/clear`, { method: "POST", body: choice }),
    onSuccess: (_d, { choice }) => deletedThere(choice),
    onError,
    onSettled: (_d, _e, { id }) => {
      refresh();
      void qc.invalidateQueries({ queryKey: keys.messages(id) });
    },
  });
  // "Clear chat (Sangam only)": one click, no dialog. Messages stay on the service; Undo brings them back here.
  const clearLocal = (c: Pick<Conversation, "id" | "name">) => {
    qc.setQueryData<Message[]>(keys.messages(c.id), []);
    api<{ ids: number[] }>(`/conversations/${c.id}/clear`, { method: "POST", body: { scope: "relay" } })
      .then(({ ids }) => {
        if (!ids.length) return;
        toast(`Cleared “${c.name}” in Sangam`, {
          description: "Still there in the app itself",
          action: { label: "Undo", onClick: () => void api(`/conversations/${c.id}/restore`, { method: "POST", body: { ids } }).catch(onError) },
        });
      })
      .catch(onError)
      .finally(() => {
        refresh();
        void qc.invalidateQueries({ queryKey: keys.messages(c.id) });
        void qc.invalidateQueries({ queryKey: keys.media(c.id) });
      });
  };
  const send = useMutation({
    mutationFn: ({ id, text, html, files = [] }: { id: number; text: string; html?: string | undefined; files?: File[] }) => {
      if (!files.length) return api(`/conversations/${id}/messages`, { method: "POST", body: { text, ...(html && { html }) } });
      const form = new FormData();
      form.append("text", text);
      if (html) form.append("html", html);
      for (const f of files) form.append("files", f, f.name);
      return apiForm(`/conversations/${id}/messages`, form);
    },
    onError,
    // Show the sent message right away, without depending on the live stream.
    onSuccess: (_d, { id }) => {
      expectReplySoon();
      refresh();
      void qc.invalidateQueries({ queryKey: keys.messages(id) });
    },
  });
  const deleteMessage = useMutation({
    mutationFn: ({ message, choice }: { message: Message; choice: DeleteChoice }) => api(`/messages/${message.id}`, { method: "DELETE", body: choice }),
    onMutate: ({ message }) => qc.setQueryData<Message[]>(keys.messages(message.conversationId), (ms) => ms?.filter((x) => x.id !== message.id)),
    onSuccess: (_d, { choice }) => deletedThere(choice),
    onError,
    onSettled: (_d, _e, { message }) => {
      refresh();
      void qc.invalidateQueries({ queryKey: keys.messages(message.conversationId) });
    },
  });
  const press = useMutation({
    mutationFn: ({ messageId, row, col }: { messageId: number; row: number; col: number }) =>
      api<{ answer?: string; url?: string }>(`/messages/${messageId}/press`, { method: "POST", body: { row, col } }),
    onError,
    // Bots answer a press with a short popup text and/or a link; message edits arrive live.
    onSuccess: (r) => {
      if (r.answer) toast(clip(r.answer, 140));
      if (r.url) window.open(r.url, "_blank", "noopener,noreferrer");
    },
  });
  return { update, remove, clear, clearLocal, send, deleteMessage, press };
}

type RelayEvent =
  | { type: "conversation"; id: number }
  | { type: "message"; conversationId: number; messageId: number; direction: "in" | "out" }
  | { type: "account"; id: number }
  | { type: "jobs" }
  | { type: "reset" };

export type JobInfo = { id: number; name: string; label: string; priority: "high" | "normal" | "low"; state: "queued" | "running" | "waiting" | "done" | "failed"; attempts: number; queuedAt: number; startedAt: number | null; finishedAt: number | null; error: string | null };
export type QueueInfo = { accountId: number; channel: string; pausedUntil: number | null; pauseReason: string | null; running: JobInfo[]; queued: JobInfo[]; recent: JobInfo[] };

/** Every account's job queue (kept fresh by "jobs" live events). */
export function useJobs() {
  return useQuery({ queryKey: keys.jobs, queryFn: () => api<QueueInfo[]>("/jobs"), refetchInterval: (q) => (q.state.data?.some((x) => x.pausedUntil) ? 5_000 : false) });
}

/** Refresh one account, or every account. */
export function useRefresh() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (accountId?: number) => api(accountId ? `/accounts/${accountId}/refresh` : "/refresh", { method: "POST" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.jobs }),
    onError: (e: Error) => toast.error(e.message),
  });
}

export type ChatMedia = {
  media: { id: number; name: string; mime: string; size: number | null; sentAt: number; thumb?: boolean }[];
  docs: { id: number; name: string; mime: string; size: number | null; sentAt: number }[];
  links: { url: string; messageId: number; sentAt: number }[];
};
/** Fetches the next batch of older messages from the service (scrolling up in a chat). */
export function useLoadOlder(conversationId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ added: number; done: boolean }>(`/conversations/${conversationId}/older`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.messages(conversationId) }),
  });
}

/** Group info → members, fetched live from the service (null for one-to-one chats). */
export function useGroupMembers(id: number, enabled: boolean) {
  return useQuery({
    queryKey: ["members", id],
    queryFn: () => api<GroupMembers | null>(`/conversations/${id}/members`),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useChatMedia(id: number) {
  return useQuery({ queryKey: keys.media(id), queryFn: () => api<ChatMedia>(`/conversations/${id}/media`) });
}

/** Subscribes to the backend's live event stream and keeps cached data fresh. */
export function useLiveUpdates(enabled: boolean, activeId: number | null, settings: Settings, onOpen: (convoId: number) => void) {
  const qc = useQueryClient();
  const activeRef = useRef(activeId);
  activeRef.current = activeId;
  // Read at notification time, so changing settings doesn't reconnect the event stream.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  useEffect(() => {
    if (!enabled) return;
    // A sync can emit hundreds of events in a burst; refetch once per burst, not once per event.
    const pending = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const invalidate = (key: readonly unknown[]) => {
      pending.add(JSON.stringify(key));
      timer ??= setTimeout(() => {
        for (const k of pending) void qc.invalidateQueries({ queryKey: JSON.parse(k) as unknown[] });
        pending.clear();
        timer = undefined;
      }, 250);
    };

    const onMessage = (e: MessageEvent<string>) => {
      const event = JSON.parse(e.data) as RelayEvent;
      if (event.type === "reset") return void qc.invalidateQueries();
      if (event.type === "account") return invalidate(keys.accounts);
      if (event.type === "jobs") return invalidate(keys.jobs);
      invalidate(keys.conversations);
      const convoId = event.type === "message" ? event.conversationId : event.id;
      invalidate(keys.messages(convoId));
      invalidate(keys.media(convoId));
      invalidate(keys.bot(convoId));
      invalidate(["message-filter"]);
      if (event.type === "message" && event.direction === "in") {
        incoming.add(convoId);
        notifyTimer ??= setTimeout(() => void notifyIncoming(), 800);
      }
    };

    // Messages arriving together (a sync, a busy group) are announced together, once.
    const incoming = new Set<number>();
    let notifyTimer: ReturnType<typeof setTimeout> | undefined;
    async function notifyIncoming() {
      const ids = [...incoming];
      incoming.clear();
      notifyTimer = undefined;
      const convos = await qc.fetchQuery({ queryKey: keys.conversations, queryFn: () => api<Conversation[]>("/conversations"), staleTime: 0 });
      const alerts: Alert[] = convos
        .filter((c) => ids.includes(c.id) && c.lastMessage?.direction === "in" && shouldNotify(c, settingsRef.current, activeRef.current))
        .map((c) => ({ convoId: c.id, name: c.name, channel: ch(c.channel).name, subject: c.subject, text: c.lastMessage!.text, icon: avatarUrl(c) }));
      showAlerts(alerts, settingsRef.current, (id) => onOpenRef.current(id));
    }

    // Browsers give up on an EventSource for good when it gets an HTTP error (e.g. a 502 from the
    // dev proxy while the backend restarts), so reconnect ourselves with backoff. Events missed
    // while disconnected are recovered by refetching everything once the stream is back.
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let missedEvents = false;
    let disposed = false;

    // The server pings every 10s. A proxy can leave a dead stream looking open (no data, no
    // error) after a backend restart, so silence for 25s means: drop it and reconnect.
    const alive = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        missedEvents = true;
        setLiveStatus("connecting");
        source?.close();
        connect();
      }, 25_000);
    };

    const connect = () => {
      source = new EventSource(withBase("/api/events"));
      source.onmessage = (e: MessageEvent<string>) => {
        alive();
        onMessage(e);
      };
      source.addEventListener("ping", alive);
      alive();
      source.onopen = () => {
        setLiveStatus("live");
        if (missedEvents) void qc.invalidateQueries();
        missedEvents = false;
        failures = 0;
      };
      source.onerror = () => {
        missedEvents = true;
        setLiveStatus("connecting");
        if (disposed || source?.readyState !== EventSource.CLOSED) return; // still auto-reconnecting
        failures++;
        retryTimer = setTimeout(connect, Math.min(30_000, 1000 * 2 ** (failures - 1)));
      };
    };
    connect();

    return () => {
      disposed = true;
      source?.close();
      clearTimeout(retryTimer);
      clearTimeout(watchdog);
      clearTimeout(timer);
      clearTimeout(notifyTimer);
    };
  }, [enabled, qc]);
}

export function useTabBadge(unread: number) {
  useEffect(() => {
    document.title = unread ? `(${unread}) Sangam` : "Sangam — Unified Inbox";
    // Installed app: the count also shows on its taskbar / dock icon.
    setAppBadge(unread);
  }, [unread]);
}
