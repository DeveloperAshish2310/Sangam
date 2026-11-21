import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AlertCircle, Archive, Loader2, CaseSensitive, Eraser, FolderInput, ShieldAlert, ShieldCheck, Check, ChevronDown, CheckCheck, Clock, Copy, Forward, Image as ImageIcon, MoreHorizontal, Paperclip, Reply, Send, Smile, Star, Tag, Trash2, Users } from "lucide-react";
import { EmailFrame, hasRemoteImages } from "./EmailFrame";
import { useBotInfo, useLoadOlder, useMessages, useRelayActions, useSettings } from "@/hooks/use-relay";
import { BotKeyboard, CommandList, MessageButtons, RichText } from "./BotExtras";
import { askDelete } from "./ConfirmDelete";
import { AttachmentList, Lightbox, PendingFiles } from "./Attachments";
import { toast } from "sonner";
import { AnimatePresence, motion } from "motion/react";
import { menuMotion, spring } from "./motion";
import { RichComposer, type ComposerHandle } from "./RichComposer";
import { bubbleHtml, isComposedHtml, outgoingFor, signatureApplies, withSignature } from "@/lib/formatting";
import { baseDomain, ch, emailDomain, formatTime, trustedDomainFor, type Account, type Attachment, type Conversation, type Message } from "@/lib/relay";
import { Avatar, avatarUrl, MenuButtons, PopupMenu, useDismiss, type MenuAction } from "./common";

type Props = {
  convo: Conversation;
  account: Account | undefined;
  onContact: () => void;
  onAddTag: () => void;
  onClosed: () => void;
  onMove: () => void;
  onSpam: () => void;
};

// Same limits as the backend (Gmail caps a whole email at 25 MB).
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 10;

const QUICK_REPLIES = ["Sounds good 👍", "I'll get back to you shortly", "Thanks!"];

export function Thread({ convo, account, onContact, onAddTag, onClosed, onMove, onSpam }: Props) {
  const { data: messages = [], isSuccess: messagesLoaded } = useMessages(convo.id);
  const { update, remove, clearLocal, send, deleteMessage, press } = useRelayActions();
  const { data: bot } = useBotInfo(convo.id, convo.channel === "telegram");
  const commands = bot?.commands ?? [];
  const [showCommands, setShowCommands] = useState(false);
  // `draft` mirrors the editor's plain text (for the Send button and "/" commands).
  const [draft, setDraft] = useState("");
  const composer = useRef<ComposerHandle>(null);
  const setComposer = (text: string) => composer.current?.setText(text);
  const [toolbar, setToolbar] = useState(false);
  const onDraftChange = useCallback((text: string) => setDraft(text), []);
  const [menu, setMenu] = useState<{ x: number; y: number; message: Message } | null>(null);
  const [headerMenu, setHeaderMenu] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const C = ch(convo.channel);
  const isDemo = account?.status === "demo";

  // A message arriving in the chat you're looking at is read — also on the service — but only
  // while the tab is actually visible, so messages that came in while away stay unread.
  useEffect(() => {
    const markIfVisible = () => {
      if (convo.unread > 0 && document.visibilityState === "visible" && !update.isPending) update.mutate({ id: convo.id, patch: { unread: 0 } });
    };
    markIfVisible();
    document.addEventListener("visibilitychange", markIfVisible);
    return () => document.removeEventListener("visibilitychange", markIfVisible);
  }, [convo.id, convo.unread]); // eslint-disable-line react-hooks/exhaustive-deps

  // New messages (or opening the chat) scroll to the bottom; older ones loaded at the top keep
  // you where you were. `fromBottom` is kept up to date as you scroll.
  const scroller = useRef<HTMLDivElement>(null);
  const fromBottom = useRef(0);
  const shown = useRef<{ convo: number; first: number | undefined; last: number | undefined }>({ convo: 0, first: undefined, last: undefined });
  const firstId = messages[0]?.id;
  const lastId = messages.at(-1)?.id;
  useLayoutEffect(() => {
    const el = scroller.current;
    const prev = shown.current;
    const prepended = el && prev.convo === convo.id && prev.last === lastId && prev.first !== undefined && prev.first !== firstId;
    if (prepended) el.scrollTop = el.scrollHeight - fromBottom.current;
    // Braces matter: newer browsers return a Promise from scrollIntoView, which React would treat as a cleanup.
    else { bottom.current?.scrollIntoView({ block: "end" }); }
    shown.current = { convo: convo.id, first: firstId, last: lastId };
  }, [messages.length, convo.id, firstId, lastId]);
  const onScroll = () => {
    const el = scroller.current;
    if (el) fromBottom.current = el.scrollHeight - el.scrollTop;
  };

  // Older history: fetched from the service when you scroll near the top.
  const older = useLoadOlder(convo.id);
  const [olderDone, setOlderDone] = useState(false);
  const loadingOlder = useRef(false);
  const topSentinel = useRef<HTMLDivElement>(null);
  const canLoadOlder = convo.channel === "telegram" && !isDemo && messagesLoaded;
  useEffect(() => setOlderDone(false), [convo.id]);
  const loadOlder = useCallback(() => {
    if (loadingOlder.current || olderDone) return;
    loadingOlder.current = true;
    onScroll();
    older.mutate(undefined, {
      onSuccess: (r) => { if (r.done) setOlderDone(true); },
      onError: (e) => { setOlderDone(true); toast.error(`Couldn't load older messages: ${e instanceof Error ? e.message : String(e)}`); },
      onSettled: () => { loadingOlder.current = false; },
    });
  }, [older, olderDone]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = topSentinel.current;
    const root = scroller.current;
    if (!canLoadOlder || olderDone || !el || !root) return undefined;
    const io = new IntersectionObserver(([e]) => { if (e?.isIntersecting) loadOlder(); }, { root, rootMargin: "300px 0px 0px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [canLoadOlder, olderDone, loadOlder, messages.length]);

  const [sentTick, setSentTick] = useState(0);
  // Messages already there when the chat opens appear instantly; only new arrivals animate in.
  const initialIds = useRef<Set<number> | null>(null);
  const initialLatest = useRef(0);
  if (initialIds.current === null && messagesLoaded) {
    initialIds.current = new Set(messages.map((m) => m.id));
    initialLatest.current = messages.at(-1)?.sentAt ?? 0;
  }
  // (Older history loaded at the top isn't "new", so it doesn't animate in.)
  const isNew = (m: Message) => !!initialIds.current && !initialIds.current.has(m.id) && m.sentAt >= initialLatest.current;

  // Files waiting to go with the next message (📎, drag & drop, or paste).
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [lightbox, setLightbox] = useState<Attachment | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const addFiles = (list: FileList | File[] | null) => {
    const picked = [...(list ?? [])];
    if (!picked.length) return;
    setFiles((prev) => {
      const next = [...prev, ...picked].slice(0, MAX_FILES);
      const total = next.reduce((n, f) => n + f.size, 0);
      if (total > MAX_BYTES) {
        toast.error("Attachments are limited to 25 MB per message");
        return prev;
      }
      if (prev.length + picked.length > MAX_FILES) toast.error(`Up to ${MAX_FILES} files per message`);
      return next;
    });
  };

  const sendText = (text: string, withFiles: File[] = [], html?: string) => {
    if ((!text.trim() && !withFiles.length) || send.isPending) return;
    setShowCommands(false);
    send.mutate(
      { id: convo.id, text: text.trim(), html, files: withFiles },
      { onSuccess: () => { composer.current?.clear(); setFiles([]); setSentTick((t) => t + 1); } },
    );
  };
  // The editor's content, converted to what this channel understands (WhatsApp markers, Telegram/email HTML).
  const { settings } = useSettings(true);
  const submit = () => {
    const content = composer.current?.getHtml() ?? "";
    const signed = signatureApplies(convo.channel, draft, settings) ? withSignature(content, settings!.signature) : content;
    const { text, html } = outgoingFor(convo.channel, signed);
    sendText(text, files, html);
  };
  // Typing "/" in a chat with bots opens their command list, like Telegram does.
  const commandFilter = commands.length && (showCommands || /^\/\w*$/.test(draft)) ? (showCommands && !draft.startsWith("/") ? "/" : draft) : null;
  // /commands in incoming Telegram messages are tappable, like in the Telegram app.
  const onCommand = convo.channel === "telegram" ? sendText : undefined;

  const messageActions = (m: Message): MenuAction[] => [
    { icon: Reply, label: "Reply", fn: () => setComposer(`@${m.senderName ?? convo.name} `) },
    { icon: Copy, label: "Copy text", fn: () => void navigator.clipboard?.writeText(m.text) },
    { icon: Star, label: convo.starred ? "Unstar chat" : "Star chat", fn: () => update.mutate({ id: convo.id, patch: { starred: !convo.starred } }) },
    { icon: Forward, label: "Forward", fn: () => setComposer(m.text) },
    { icon: Trash2, label: "Delete", danger: true, fn: () => void askDelete("message", convo, { message: m, isDemo }).then((choice) => choice && deleteMessage.mutate({ message: m, choice })) },
  ];

  const headerActions: MenuAction[] = [
    { icon: Users, label: "Contact info", fn: onContact },
    { icon: CheckCheck, label: convo.unread ? "Mark as read" : "Mark as unread", fn: () => update.mutate({ id: convo.id, patch: { unread: convo.unread ? 0 : 1 } }) },
    { icon: Tag, label: "Add tag", fn: onAddTag },
    { icon: FolderInput, label: "Move to…  (V)", fn: onMove },
    convo.folder === "spam" ? { icon: ShieldCheck, label: "Not spam", fn: onSpam } : { icon: ShieldAlert, label: "Mark as spam  (!)", fn: onSpam },
  ];
  const deleteChat = () => void askDelete("chat", convo, { isDemo }).then((choice) => { if (choice) { remove.mutate({ id: convo.id, choice }); onClosed(); } });

  return (
    <motion.main className="relative flex min-w-0 flex-1 flex-col" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.2, ease: "easeOut" }}
      onDragEnter={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragging(true); } }}
      onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={(e) => { if (e.dataTransfer.files.length) { e.preventDefault(); addFiles(e.dataTransfer.files); } setDragging(false); }}>
      <AnimatePresence>
        {dragging && (
          <motion.div key="drop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="pointer-events-none absolute inset-3 z-40 grid place-items-center rounded-2xl border-2 border-dashed border-primary bg-primary/10 backdrop-blur-[2px]">
            <motion.p initial={{ scale: 0.9 }} animate={{ scale: 1 }} className="flex items-center gap-2 rounded-xl bg-popover px-4 py-2 text-sm font-semibold shadow-soft">
              <Paperclip className="h-4 w-4" /> Drop files to attach
            </motion.p>
          </motion.div>
        )}
      </AnimatePresence>
      <Lightbox attachment={lightbox} onClose={() => setLightbox(null)} />
      <header className="flex items-center gap-3 border-b bg-surface px-6 py-4">
        <button onClick={onContact} title="View contact info" className="pv -m-1 flex min-w-0 flex-1 items-center gap-3 rounded-lg p-1 text-left transition hover:bg-muted/60">
          <Avatar name={convo.name} channel={convo.channel} photo={avatarUrl(convo)} />
          <div className="min-w-0 flex-1">
            <h2 className="truncate font-semibold">{convo.subject ?? convo.name}</h2>
            <p className="truncate text-xs text-muted-foreground">
              {convo.subject && `${convo.name} · `}via {C.name}{account && ` · ${account.status === "demo" ? "Demo data" : account.displayName}`}
            </p>
          </div>
        </button>
        <button
          onClick={() => update.mutate({ id: convo.id, patch: { starred: !convo.starred } })}
          title={convo.starred ? "Unstar chat" : "Star chat"}
          className={`grid h-9 w-9 place-items-center rounded-lg transition hover:bg-muted ${convo.starred ? "text-primary" : "text-muted-foreground"}`}>
          <Star className={`h-4 w-4 ${convo.starred ? "fill-primary" : ""}`} />
        </button>
        <button
          onClick={() => { update.mutate({ id: convo.id, patch: { archived: !convo.archived } }); if (!convo.archived) onClosed(); }}
          title={convo.archived ? "Unarchive" : "Archive"}
          className="grid h-9 w-9 place-items-center rounded-lg text-muted-foreground transition hover:bg-muted">
          <Archive className="h-4 w-4" />
        </button>
        <button onClick={() => clearLocal(convo)} title="Clear chat in Sangam (Undo available; stays in the app itself)"
          className="grid h-9 w-9 place-items-center rounded-lg text-muted-foreground transition hover:bg-muted hover:text-foreground">
          <Eraser className="h-4 w-4" />
        </button>
        <button onClick={deleteChat} title="Delete chat"
          className="grid h-9 w-9 place-items-center rounded-lg text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive">
          <Trash2 className="h-4 w-4" />
        </button>
        <div className="relative">
          <button onClick={(e) => { e.stopPropagation(); setHeaderMenu((v) => !v); }} title="More actions"
            className="grid h-9 w-9 place-items-center rounded-lg text-muted-foreground transition hover:bg-muted">
            <MoreHorizontal className="h-4 w-4" />
          </button>
          {headerMenu && <HeaderMenu actions={headerActions} onClose={() => setHeaderMenu(false)} />}
        </div>
      </header>

      <div ref={scroller} onScroll={onScroll} className="scrollbar-thin flex-1 space-y-3 overflow-y-auto px-8 py-6">
        {canLoadOlder && (
          <div ref={topSentinel} className="flex min-h-7 justify-center text-xs text-muted-foreground">
            {older.isPending ? (
              <span className="flex items-center gap-1.5"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading older messages…</span>
            ) : olderDone ? (
              <span>Start of this chat</span>
            ) : (
              <button onClick={loadOlder} className="rounded-full px-3 py-1 transition hover:bg-muted hover:text-foreground">Load older messages</button>
            )}
          </div>
        )}
        <AnimatePresence initial={false}>
        {messages.map((m) => (
          <MessageMotion key={m.id} isNew={isNew(m)} out={m.direction === "out"}>
          {m.html && m.direction === "in" ? (
          <EmailMessage key={m.id} message={m} html={m.html} senderDomain={senderDomainOf(convo)} highlighted={menu?.message.id === m.id}
            onContextMenu={(x, y) => setMenu({ x, y, message: m })} onOpenImage={setLightbox} />
        ) : (
          <div key={m.id} className={`flex flex-col ${m.direction === "out" ? "items-end" : "items-start"}`}>
            <div className="flex w-full max-w-[65%] flex-col" style={{ alignItems: m.direction === "out" ? "flex-end" : "flex-start" }}>
            <div
              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY, message: m }); }}
              className={`pv max-w-full cursor-default rounded-2xl px-4 py-2.5 text-sm shadow-soft ${m.direction === "out" ? "rounded-br-md bg-primary text-primary-foreground" : "rounded-bl-md bg-card"} ${menu?.message.id === m.id ? "ring-2 ring-ring" : ""}`}>
              {m.attachments.length > 0 && (
                <div className={m.extra?.mediaLabel ? "" : "mb-1.5"}>
                  <AttachmentList attachments={m.attachments} out={m.direction === "out"} onOpenImage={setLightbox} />
                </div>
              )}
              {/* "📷 Photo"-style stand-in text is redundant once the file itself is shown. */}
              {!(m.extra?.mediaLabel && m.attachments.length) &&
                (m.html && isComposedHtml(m.html) ? <div className="rich-text whitespace-pre-wrap break-words leading-relaxed" dangerouslySetInnerHTML={{ __html: bubbleHtml(m.html) }} />
                  : <RichText text={m.text} whatsapp={convo.channel === "whatsapp"} onCommand={m.direction === "in" ? onCommand : undefined} />)}
              <p className={`mt-1 flex items-center justify-end gap-1 text-[10px] ${m.direction === "out" ? "text-primary-foreground/70" : "text-muted-foreground"}`}>
                {formatTime(m.sentAt)} {m.direction === "out" && <StatusIcon status={m.status} />}
              </p>
            </div>
            </div>
            {m.extra?.buttons && (
              <div className="pv max-w-[65%]">
                <MessageButtons message={m} pending={press.isPending} onPress={(row, col) => press.mutate({ messageId: m.id, row, col })} />
              </div>
            )}
          </div>
          )}
          </MessageMotion>
        ))}
        </AnimatePresence>
        <div ref={bottom} />
      </div>

      {convo.channel === "sangam" ? (
        <p className="border-t bg-surface p-4 text-center text-xs text-muted-foreground">
          Sangam posts here when an account stops working, with how to fix it. Replies aren't sent anywhere.
        </p>
      ) : convo.readOnly ? (
        <p className="border-t bg-surface p-4 text-center text-xs text-muted-foreground">
          This is a channel — only its admins can post here.
        </p>
      ) : (
      <div className="border-t bg-surface p-4">
        <PendingFiles files={files} onRemove={(i) => setFiles((fs) => fs.filter((_, j) => j !== i))} />
        {commandFilter !== null && <CommandList commands={commands} filter={commandFilter} onPick={sendText} />}
        {bot?.keyboard?.length ? (
          <BotKeyboard rows={bot.keyboard} onSend={sendText} />
        ) : commands.length ? null : (
          <div className="flex gap-2 pb-2">
            {QUICK_REPLIES.map((s) => (
              <button key={s} onClick={() => setComposer(s)} className="rounded-full bg-accent px-3 py-1 text-xs font-medium text-accent-foreground hover:opacity-80">{s}</button>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2 rounded-2xl border bg-card p-2 shadow-soft">
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
          <button onClick={() => fileInput.current?.click()} title="Attach files (or drop / paste them)" className="grid h-9 w-9 place-items-center rounded-lg text-muted-foreground hover:bg-muted"><Paperclip className="h-4 w-4" /></button>
          <RichComposer ref={composer} channel={convo.channel} placeholder={`Reply via ${C.name}…`} showToolbar={toolbar}
            onChange={onDraftChange} onSubmit={submit} onPasteFiles={addFiles} />
          <button onClick={() => setToolbar((v) => !v)} title={toolbar ? "Hide formatting" : `Formatting (what ${C.name} supports)`} aria-pressed={toolbar}
            className={`grid h-9 w-9 place-items-center rounded-lg hover:bg-muted ${toolbar ? "bg-muted text-primary" : "text-muted-foreground"}`}><CaseSensitive className="h-4 w-4" /></button>
          {commands.length > 0 && (
            <button onClick={() => setShowCommands((v) => !v)} title="Bot commands"
              className={`grid h-9 w-9 place-items-center rounded-lg font-mono text-sm font-bold hover:bg-muted ${showCommands ? "bg-muted text-primary" : "text-muted-foreground"}`}>/</button>
          )}
          <button title="Emoji are coming soon" className="grid h-9 w-9 place-items-center rounded-lg text-muted-foreground hover:bg-muted"><Smile className="h-4 w-4" /></button>
          <button onClick={submit} disabled={(!draft.trim() && !files.length) || send.isPending} className="flex h-9 items-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-40">
            Send
            {/* The plane flies off after each send and glides back in. */}
            <motion.span key={sentTick} className="inline-flex" initial={false}
              animate={sentTick ? { x: [0, 28, -16, 0], y: [0, -20, 10, 0], opacity: [1, 0, 0, 1] } : {}}
              transition={{ duration: 0.65, times: [0, 0.45, 0.46, 1], ease: "easeOut" }}>
              <Send className="h-3.5 w-3.5" />
            </motion.span>
          </button>
        </div>
      </div>
      )}

      {menu && <PopupMenu x={menu.x} y={menu.y} width={176} actions={messageActions(menu.message)} onClose={() => setMenu(null)} />}
    </motion.main>
  );
}

function EmailMessage({ message: m, html, senderDomain, highlighted, onContextMenu, onOpenImage }: { message: Message; html: string; senderDomain: string | null; highlighted: boolean; onContextMenu: (x: number, y: number) => void; onOpenImage: (a: Attachment) => void }) {
  const [formatted, setFormatted] = useState(true);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [imageMenu, setImageMenu] = useState(false);
  const { settings, update } = useSettings(true);
  const trusted = settings?.trustedImageDomains ?? [];
  const trustedBy = trustedDomainFor(senderDomain, trusted);
  // Images load when asked for this once, for every email (Settings), or for this sender's domain.
  const images = loadedOnce || !!settings?.autoLoadImages || !!trustedBy;
  const remote = hasRemoteImages(html);
  const chip = "rounded-md px-2 py-0.5 text-[11px] font-medium transition hover:bg-muted";
  const setTrust = (domain: string, on: boolean) =>
    update({ trustedImageDomains: on ? [...new Set([...trusted, domain])] : trusted.filter((d) => d !== domain) });
  return (
    <div
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onContextMenu(e.clientX, e.clientY); }}
      className={`pv max-w-[85%] overflow-hidden rounded-2xl rounded-bl-md border bg-card shadow-soft ${highlighted ? "ring-2 ring-ring" : ""}`}>
      <div className="flex items-center gap-2 border-b px-4 py-2 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">{m.senderName}</span>
        <span className="shrink-0">{formatTime(m.sentAt)}</span>
        {formatted && remote && !images && (
          <div className="relative flex items-center">
            <button onClick={() => setLoadedOnce(true)} title="Remote images can tell the sender you opened this email" className={`${chip} flex items-center gap-1 rounded-r-none text-primary`}>
              <ImageIcon className="h-3 w-3" /> Load images
            </button>
            <button onClick={(e) => { e.stopPropagation(); setImageMenu((v) => !v); }} title="More image options" aria-expanded={imageMenu}
              className={`${chip} rounded-l-none border-l px-1 text-primary`}><ChevronDown className="h-3 w-3" /></button>
            {imageMenu && (
              <ImageMenu onClose={() => setImageMenu(false)} actions={[
                { label: "Load images in this email", fn: () => setLoadedOnce(true) },
                ...(senderDomain ? [{ label: `Always load images from ${senderDomain}`, fn: () => setTrust(senderDomain, true) }] : []),
                { label: "Always load images in all emails", fn: () => update({ autoLoadImages: true }) },
              ]} />
            )}
          </div>
        )}
        {formatted && remote && trustedBy && !settings?.autoLoadImages && (
          <button onClick={() => setTrust(trustedBy, false)} title={`Images load automatically for ${trustedBy}. Click to stop.`}
            className={`${chip} flex items-center gap-1`}>
            <ImageIcon className="h-3 w-3" /> Trusted · Stop
          </button>
        )}
        <button onClick={() => setFormatted((v) => !v)} className={chip}>{formatted ? "Plain text" : "Formatted"}</button>
      </div>
      {formatted ? <EmailFrame html={html} allowImages={images} /> : <p className="whitespace-pre-wrap break-words px-4 py-3 text-sm leading-relaxed">{m.text}</p>}
      {m.attachments.length > 0 && (
        <div className="border-t px-4 py-3">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">{m.attachments.length} attachment{m.attachments.length === 1 ? "" : "s"}</p>
          <AttachmentList attachments={m.attachments} out={false} onOpenImage={onOpenImage} />
        </div>
      )}
    </div>
  );
}

/** The sender's main domain, for trusting their images ("rmp.flipkart.com" → "flipkart.com"). */
function senderDomainOf(convo: Conversation) {
  const domain = emailDomain(convo.handle.email);
  return domain ? baseDomain(domain) : null;
}

function ImageMenu({ actions, onClose }: { actions: { label: string; fn: () => void }[]; onClose: () => void }) {
  useDismiss(onClose);
  return (
    <motion.div {...menuMotion} style={{ transformOrigin: "top right" }} onClick={(e) => e.stopPropagation()}
      className="absolute right-0 top-7 z-50 w-64 overflow-hidden rounded-xl border bg-popover py-1 text-foreground shadow-soft">
      {actions.map((a) => (
        <button key={a.label} onClick={() => { a.fn(); onClose(); }} className="block w-full truncate px-3 py-2 text-left text-xs hover:bg-muted">{a.label}</button>
      ))}
      <p className="border-t px-3 py-1.5 text-[10px] text-muted-foreground">Images can tell the sender you opened their email. Change this in Settings.</p>
    </motion.div>
  );
}

function HeaderMenu({ actions, onClose }: { actions: MenuAction[]; onClose: () => void }) {
  useDismiss(onClose);
  return (
    <motion.div {...menuMotion} style={{ transformOrigin: "top right" }} className="absolute right-0 top-10 z-50 w-48 overflow-hidden rounded-xl border bg-popover py-1 shadow-soft" onClick={(e) => e.stopPropagation()}>
      <MenuButtons actions={actions} onClose={onClose} />
    </motion.div>
  );
}

/** Wraps one message: new ones pop in from their side, deleted ones shrink away, neighbours glide. */
function MessageMotion({ isNew, out, children }: { isNew: boolean; out: boolean; children: React.ReactNode }) {
  return (
    <motion.div
      layout="position"
      initial={isNew ? { opacity: 0, y: 14, x: out ? 18 : -18, scale: 0.94 } : false}
      animate={{ opacity: 1, y: 0, x: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9, transition: { duration: 0.16 } }}
      transition={spring}
      style={{ transformOrigin: out ? "bottom right" : "bottom left" }}
    >
      {children}
    </motion.div>
  );
}

function StatusIcon({ status }: { status: Message["status"] }) {
  if (status === "sending") return <Clock className="h-3 w-3" />;
  if (status === "failed") return <AlertCircle className="h-3 w-3" />;
  if (status === "sent") return <Check className="h-3 w-3" />;
  return <CheckCheck className="h-3 w-3" />;
}
