import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import type { DeleteChoice } from "@/components/relay/ConfirmDelete";
import { api, apiForm, ch, DEFAULT_SETTINGS, type Account, type BotInfo, type ChannelId, type Conversation, type Message, type Settings, type User } from "@/lib/relay";

export const keys = {
  auth: ["auth"] as const,
  settings: ["settings"] as const,
  accounts: ["accounts"] as const,
  conversations: ["conversations"] as const,
  messages: (id: number) => ["messages", id] as const,
  search: (q: string) => ["search", q] as const,
  bot: (id: number) => ["bot", id] as const,
};

export function useAuth() {
  return useQuery({ queryKey: keys.auth, queryFn: () => api<{ hasUser: boolean; user: User | null }>("/auth/status") });
}

export function useSettings(enabled: boolean) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: keys.settings,
    queryFn: async () => ({ ...DEFAULT_SETTINGS, ...(await api<Partial<Settings>>("/settings")) }),
    enabled,
  });
  const update = (patch: Partial<Settings>) => {
    // Optimistic: theme toggles must feel instant.
    qc.setQueryData<Settings>(keys.settings, (s) => ({ ...(s ?? DEFAULT_SETTINGS), ...patch }));
    api("/settings", { method: "PUT", body: patch }).catch((e: Error) => toast.error(e.message));
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

export function useConversations(enabled: boolean) {
  const status = useLiveStatus();
  return useQuery({
    queryKey: keys.conversations,
    queryFn: () => api<Conversation[]>("/conversations"),
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
    mutationFn: ({ id, patch }: { id: number; patch: Partial<Pick<Conversation, "unread" | "starred" | "archived" | "tags">> }) =>
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
  const send = useMutation({
    mutationFn: ({ id, text, files = [] }: { id: number; text: string; files?: File[] }) => {
      if (!files.length) return api(`/conversations/${id}/messages`, { method: "POST", body: { text } });
      const form = new FormData();
      form.append("text", text);
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
      if (r.answer) toast(r.answer);
      if (r.url) window.open(r.url, "_blank", "noopener,noreferrer");
    },
  });
  return { update, remove, clear, send, deleteMessage, press };
}

type RelayEvent =
  | { type: "conversation"; id: number }
  | { type: "message"; conversationId: number; messageId: number; direction: "in" | "out" }
  | { type: "account"; id: number }
  | { type: "reset" };

/** Subscribes to the backend's live event stream and keeps cached data fresh. */
export function useLiveUpdates(enabled: boolean, activeId: number | null) {
  const qc = useQueryClient();
  const activeRef = useRef(activeId);
  activeRef.current = activeId;

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
      invalidate(keys.conversations);
      const convoId = event.type === "message" ? event.conversationId : event.id;
      invalidate(keys.messages(convoId));
      invalidate(keys.bot(convoId));
      invalidate(["message-filter"]);
      if (event.type === "message" && event.direction === "in" && convoId !== activeRef.current) void notifyIncoming(convoId);
    };

    async function notifyIncoming(convoId: number) {
      const convos = await qc.fetchQuery({ queryKey: keys.conversations, queryFn: () => api<Conversation[]>("/conversations") });
      const c = convos.find((x) => x.id === convoId);
      if (c?.lastMessage) toast(`${c.name} · ${ch(c.channel).name}`, { description: c.lastMessage.text });
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
      source = new EventSource("/api/events");
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
    };
  }, [enabled, qc]);
}

export function useTabBadge(unread: number) {
  useEffect(() => {
    document.title = unread ? `(${unread}) Sangam` : "Sangam — Unified Inbox";
  }, [unread]);
}
