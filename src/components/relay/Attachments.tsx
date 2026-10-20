import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Download, File as FileIcon, FileText, Image as ImageIcon, Music, Video, X } from "lucide-react";
import type { Attachment } from "@/lib/relay";
import { dialogMotion, fade } from "./motion";

// Kept in step with the backend's INLINE_SAFE list: only these are shown inside the page.
const IMAGE = /^image\/(png|jpeg|gif|webp|avif|bmp)$/;
const VIDEO = /^video\/(mp4|webm|ogg|quicktime)$/;
const AUDIO = /^audio\//;
// Bigger videos would start downloading just to show a player; they get a file card instead.
const MAX_INLINE_VIDEO = 50 * 1024 * 1024;
// Matches the backend: larger files can't be opened through Sangam at all.
const MAX_OPENABLE = 200 * 1024 * 1024;

export const attachmentUrl = (a: Pick<Attachment, "id">, download = false) => `/api/attachments/${a.id}${download ? "?download=1" : ""}`;

export function formatSize(bytes: number | null | undefined) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

const iconFor = (mime: string) => (mime.startsWith("image/") ? ImageIcon : mime.startsWith("video/") ? Video : mime.startsWith("audio/") ? Music : mime === "application/pdf" || mime.startsWith("text/") ? FileText : FileIcon);

/** A file as a card: icon, name, size and a download button. */
function FileCard({ a, out }: { a: Attachment; out: boolean }) {
  const I = iconFor(a.mime);
  if ((a.size ?? 0) > MAX_OPENABLE) {
    return (
      <div title="Too large to open in Sangam — open it in the original app"
        className={`flex min-w-0 max-w-full items-center gap-2.5 rounded-xl border px-3 py-2 opacity-80 ${out ? "border-primary-foreground/20" : "bg-background/60"}`}>
        <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${out ? "bg-primary-foreground/15" : "bg-muted"}`}><I className="h-4 w-4" /></span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{a.name}</span>
          <span className={`block text-[11px] ${out ? "text-primary-foreground/70" : "text-muted-foreground"}`}>{formatSize(a.size)} · open in the original app</span>
        </span>
      </div>
    );
  }
  return (
    <a href={attachmentUrl(a, true)} download={a.name} title={`Download ${a.name}`}
      className={`flex min-w-0 max-w-full items-center gap-2.5 rounded-xl border px-3 py-2 transition-colors ${out ? "border-primary-foreground/20 hover:bg-primary-foreground/10" : "bg-background/60 hover:bg-muted"}`}>
      <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${out ? "bg-primary-foreground/15" : "bg-muted"}`}><I className="h-4 w-4" /></span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{a.name}</span>
        <span className={`block text-[11px] ${out ? "text-primary-foreground/70" : "text-muted-foreground"}`}>{formatSize(a.size) || "File"}</span>
      </span>
      <Download className="h-4 w-4 shrink-0 opacity-70" />
    </a>
  );
}

/** An image preview; falls back to a file card if it can't be loaded (e.g. removed on the service). */
function ImageThumb({ a, out, onOpen }: { a: Attachment; out: boolean; onOpen: () => void }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <FileCard a={a} out={out} />;
  return (
    <motion.button whileHover={{ scale: 1.015 }} whileTap={{ scale: 0.98 }} onClick={onOpen} title={a.name} className="block overflow-hidden rounded-xl bg-muted">
      <img src={attachmentUrl(a)} alt={a.name} loading="lazy" onError={() => setFailed(true)} className="max-h-72 w-full object-cover" />
    </motion.button>
  );
}

/** Everything attached to one message, laid out by type. */
export function AttachmentList({ attachments, out, onOpenImage }: { attachments: Attachment[]; out: boolean; onOpenImage: (a: Attachment) => void }) {
  if (!attachments.length) return null;
  const images = attachments.filter((a) => IMAGE.test(a.mime));
  const rest = attachments.filter((a) => !IMAGE.test(a.mime));
  return (
    <div className="space-y-1.5">
      {images.length > 0 && (
        <div className={`grid gap-1.5 ${images.length > 1 ? "grid-cols-2" : ""}`}>
          {images.map((a) => <ImageThumb key={a.id} a={a} out={out} onOpen={() => onOpenImage(a)} />)}
        </div>
      )}
      {rest.map((a) =>
        VIDEO.test(a.mime) && (a.size ?? 0) <= MAX_INLINE_VIDEO ? (
          <video key={a.id} controls preload="metadata" src={attachmentUrl(a)} className="max-h-80 w-full rounded-xl bg-black" />
        ) : AUDIO.test(a.mime) ? (
          <audio key={a.id} controls preload="none" src={attachmentUrl(a)} className="w-64 max-w-full" />
        ) : (
          <FileCard key={a.id} a={a} out={out} />
        ),
      )}
    </div>
  );
}

/** Full-screen image viewer with download; Esc or a click outside closes it. */
export function Lightbox({ attachment, onClose }: { attachment: Attachment | null; onClose: () => void }) {
  useEffect(() => {
    if (!attachment) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [attachment, onClose]);
  return (
    <AnimatePresence>
      {attachment && (
        <motion.div key="lightbox" className="fixed inset-0 z-[70] grid place-items-center bg-black/85 p-6 backdrop-blur-sm" onClick={onClose}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={fade}>
          <div className="absolute right-4 top-4 flex gap-2" onClick={(e) => e.stopPropagation()}>
            <a href={attachmentUrl(attachment, true)} download={attachment.name} title="Download"
              className="grid h-10 w-10 place-items-center rounded-full bg-white/10 text-white transition hover:bg-white/20"><Download className="h-5 w-5" /></a>
            <button onClick={onClose} title="Close (Esc)" className="grid h-10 w-10 place-items-center rounded-full bg-white/10 text-white transition hover:bg-white/20"><X className="h-5 w-5" /></button>
          </div>
          <motion.img {...dialogMotion} src={attachmentUrl(attachment)} alt={attachment.name} onClick={(e) => e.stopPropagation()}
            className="max-h-full max-w-full rounded-lg object-contain shadow-2xl" />
          <p className="absolute bottom-4 max-w-[80%] truncate text-sm text-white/80">{attachment.name} {formatSize(attachment.size) && `· ${formatSize(attachment.size)}`}</p>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Files picked for the next message, shown above the reply box; ✕ removes one. */
export function PendingFiles({ files, onRemove }: { files: File[]; onRemove: (index: number) => void }) {
  // Local previews for picked images; revoked when the list changes so memory isn't leaked.
  const previews = useMemo(() => files.map((f) => (IMAGE.test(f.type) ? URL.createObjectURL(f) : null)), [files]);
  useEffect(() => () => previews.forEach((u) => u && URL.revokeObjectURL(u)), [previews]);
  if (!files.length) return null;
  return (
    <div className="scrollbar-thin flex gap-2 overflow-x-auto pb-2">
      <AnimatePresence initial={false}>
        {files.map((f, i) => {
          const I = iconFor(f.type);
          return (
            <motion.div key={`${f.name}-${f.size}-${f.lastModified}`} layout initial={{ opacity: 0, scale: 0.85 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.85 }}
              className="relative flex w-44 shrink-0 items-center gap-2 rounded-xl border bg-card p-1.5 pr-7">
              {previews[i] ? <img src={previews[i]!} alt="" className="h-9 w-9 shrink-0 rounded-lg object-cover" /> : <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-muted"><I className="h-4 w-4" /></span>}
              <span className="min-w-0">
                <span className="block truncate text-xs font-medium">{f.name}</span>
                <span className="block text-[10px] text-muted-foreground">{formatSize(f.size)}</span>
              </span>
              <button onClick={() => onRemove(i)} title="Remove" className="absolute right-1 top-1 grid h-5 w-5 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"><X className="h-3.5 w-3.5" /></button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
