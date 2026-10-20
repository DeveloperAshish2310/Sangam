import { useEffect, useRef, useState } from "react";
import { AlertCircle, Archive, Check, CheckCheck, Clock, Copy, Forward, Image as ImageIcon, MoreHorizontal, Paperclip, Reply, Send, Smile, Star, Tag, Trash2, Users } from "lucide-react";
import { EmailFrame, hasRemoteImages } from "./EmailFrame";
import { useBotInfo, useMessages, useRelayActions } from "@/hooks/use-relay";
import { BotKeyboard, CommandList, MessageButtons, RichText } from "./BotExtras";
import { askDelete } from "./ConfirmDelete";
import { AttachmentList, Lightbox, PendingFiles } from "./Attachments";
import { toast } from "sonner";
import { AnimatePresence, motion } from "motion/react";
import { menuMotion, spring } from "./motion";
import { ch, formatTime, type Account, type Attachment, type Conversation, type Message } from "@/lib/relay";
import { Avatar, avatarUrl, MenuButtons, PopupMenu, useDismiss, type MenuAction } from "./common";

type Props = {
  convo: Conversation;
  account: Account | undefined;
  onContact: () => void;
  onAddTag: () => void;
  onClosed: () => void;
};

// Same limits as the backend (Gmail caps a whole email at 25 MB).
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 10;

const QUICK_REPLIES = ["Sounds good 👍", "I'll get back to you shortly", "Thanks!"];

export function Thread({ convo, account, onContact, onAddTag, onClosed }: Props) {
  const { data: messages = [], isSuccess: messagesLoaded } = useMessages(convo.id);
  const { update, remove, send, deleteMessage, press } = useRelayActions();
  const { data: bot } = useBotInfo(convo.id, convo.channel === "telegram");
  const commands = bot?.commands ?? [];
  const [showCommands, setShowCommands] = useState(false);
  const [draft, setDraft] = useState("");
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

  // Braces matter: newer browsers return a Promise from scrollIntoView, which React would treat as a cleanup.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [messages.length, convo.id]);

  const [sentTick, setSentTick] = useState(0);
  // Messages already there when the chat opens appear instantly; only new arrivals animate in.
  const initialIds = useRef<Set<number> | null>(null);
  if (initialIds.current === null && messagesLoaded) initialIds.current = new Set(messages.map((m) => m.id));
  const isNew = (id: number) => !!initialIds.current && !initialIds.current.has(id);

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

  const sendText = (text: string, withFiles: File[] = []) => {
    if ((!text.trim() && !withFiles.length) || send.isPending) return;
    setShowCommands(false);
    send.mutate(
      { id: convo.id, text: text.trim(), files: withFiles },
      { onSuccess: () => { setDraft(""); setFiles([]); setSentTick((t) => t + 1); } },
    );
  };
  const submit = () => sendText(draft, files);
  // Typing "/" in a chat with bots opens their command list, like Telegram does.
  const commandFilter = commands.length && (showCommands || /^\/\w*$/.test(draft)) ? (showCommands && !draft.startsWith("/") ? "/" : draft) : null;
  // /commands in incoming Telegram messages are tappable, like in the Telegram app.
  const onCommand = convo.channel === "telegram" ? sendText : undefined;

  const messageActions = (m: Message): MenuAction[] => [
    { icon: Reply, label: "Reply", fn: () => setDraft(`@${m.senderName ?? convo.name} `) },
    { icon: Copy, label: "Copy text", fn: () => void navigator.clipboard?.writeText(m.text) },
    { icon: Star, label: convo.starred ? "Unstar chat" : "Star chat", fn: () => update.mutate({ id: convo.id, patch: { starred: !convo.starred } }) },
    { icon: Forward, label: "Forward", fn: () => setDraft(m.text) },
    { icon: Trash2, label: "Delete", danger: true, fn: () => void askDelete("message", convo, { message: m, isDemo }).then((choice) => choice && deleteMessage.mutate({ message: m, choice })) },
  ];

  const headerActions: MenuAction[] = [
    { icon: Users, label: "Contact info", fn: onContact },
    { icon: CheckCheck, label: convo.unread ? "Mark as read" : "Mark as unread", fn: () => update.mutate({ id: convo.id, patch: { unread: convo.unread ? 0 : 1 } }) },
    { icon: Tag, label: "Add tag", fn: onAddTag },
    { icon: Trash2, label: "Delete chat", danger: true, fn: () => void askDelete("chat", convo, { isDemo }).then((choice) => { if (choice) { remove.mutate({ id: convo.id, choice }); onClosed(); } }) },
  ];

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
        <button onClick={onContact} title="View contact info" className="-m-1 flex min-w-0 flex-1 items-center gap-3 rounded-lg p-1 text-left transition hover:bg-muted/60">
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
        <div className="relative">
          <button onClick={(e) => { e.stopPropagation(); setHeaderMenu((v) => !v); }} title="More actions"
            className="grid h-9 w-9 place-items-center rounded-lg text-muted-foreground transition hover:bg-muted">
            <MoreHorizontal className="h-4 w-4" />
          </button>
          {headerMenu && <HeaderMenu actions={headerActions} onClose={() => setHeaderMenu(false)} />}
        </div>
      </header>

      <div className="scrollbar-thin flex-1 space-y-3 overflow-y-auto px-8 py-6">
        <AnimatePresence initial={false}>
        {messages.map((m) => (
          <MessageMotion key={m.id} isNew={isNew(m.id)} out={m.direction === "out"}>
          {m.html && m.direction === "in" ? (
          <EmailMessage key={m.id} message={m} html={m.html} highlighted={menu?.message.id === m.id}
            onContextMenu={(x, y) => setMenu({ x, y, message: m })} onOpenImage={setLightbox} />
        ) : (
          <div key={m.id} className={`flex flex-col ${m.direction === "out" ? "items-end" : "items-start"}`}>
            <div className="flex w-full max-w-[65%] flex-col" style={{ alignItems: m.direction === "out" ? "flex-end" : "flex-start" }}>
            <div
              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY, message: m }); }}
              className={`max-w-full cursor-default rounded-2xl px-4 py-2.5 text-sm shadow-soft ${m.direction === "out" ? "rounded-br-md bg-primary text-primary-foreground" : "rounded-bl-md bg-card"} ${menu?.message.id === m.id ? "ring-2 ring-ring" : ""}`}>
              {m.attachments.length > 0 && (
                <div className={m.extra?.mediaLabel ? "" : "mb-1.5"}>
                  <AttachmentList attachments={m.attachments} out={m.direction === "out"} onOpenImage={setLightbox} />
                </div>
              )}
              {/* "📷 Photo"-style stand-in text is redundant once the file itself is shown. */}
              {!(m.extra?.mediaLabel && m.attachments.length) && <RichText text={m.text} onCommand={m.direction === "in" ? onCommand : undefined} />}
              <p className={`mt-1 flex items-center justify-end gap-1 text-[10px] ${m.direction === "out" ? "text-primary-foreground/70" : "text-muted-foreground"}`}>
                {formatTime(m.sentAt)} {m.direction === "out" && <StatusIcon status={m.status} />}
              </p>
            </div>
            </div>
            {m.extra?.buttons && (
              <div className="max-w-[65%]">
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

      <div className="border-t bg-surface p-4">
        <PendingFiles files={files} onRemove={(i) => setFiles((fs) => fs.filter((_, j) => j !== i))} />
        {commandFilter !== null && <CommandList commands={commands} filter={commandFilter} onPick={sendText} />}
        {bot?.keyboard?.length ? (
          <BotKeyboard rows={bot.keyboard} onSend={sendText} />
        ) : commands.length ? null : (
          <div className="flex gap-2 pb-2">
            {QUICK_REPLIES.map((s) => (
              <button key={s} onClick={() => setDraft(s)} className="rounded-full bg-accent px-3 py-1 text-xs font-medium text-accent-foreground hover:opacity-80">{s}</button>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2 rounded-2xl border bg-card p-2 shadow-soft">
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
          <button onClick={() => fileInput.current?.click()} title="Attach files (or drop / paste them)" className="grid h-9 w-9 place-items-center rounded-lg text-muted-foreground hover:bg-muted"><Paperclip className="h-4 w-4" /></button>
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={1}
            onPaste={(e) => { if (e.clipboardData.files.length) { e.preventDefault(); addFiles(e.clipboardData.files); } }}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
            placeholder={`Reply via ${C.name}…`} className="max-h-32 flex-1 resize-none bg-transparent py-2 text-sm outline-none" />
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

      {menu && <PopupMenu x={menu.x} y={menu.y} width={176} actions={messageActions(menu.message)} onClose={() => setMenu(null)} />}
    </motion.main>
  );
}

function EmailMessage({ message: m, html, highlighted, onContextMenu, onOpenImage }: { message: Message; html: string; highlighted: boolean; onContextMenu: (x: number, y: number) => void; onOpenImage: (a: Attachment) => void }) {
  const [formatted, setFormatted] = useState(true);
  const [images, setImages] = useState(false);
  const remote = hasRemoteImages(html);
  const chip = "rounded-md px-2 py-0.5 text-[11px] font-medium transition hover:bg-muted";
  return (
    <div
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onContextMenu(e.clientX, e.clientY); }}
      className={`max-w-[85%] overflow-hidden rounded-2xl rounded-bl-md border bg-card shadow-soft ${highlighted ? "ring-2 ring-ring" : ""}`}>
      <div className="flex items-center gap-2 border-b px-4 py-2 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">{m.senderName}</span>
        <span className="shrink-0">{formatTime(m.sentAt)}</span>
        {formatted && remote && !images && (
          <button onClick={() => setImages(true)} title="Remote images can tell the sender you opened this email" className={`${chip} flex items-center gap-1 text-primary`}>
            <ImageIcon className="h-3 w-3" /> Load images
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
