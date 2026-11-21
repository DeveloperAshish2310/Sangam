import { useState } from "react";
import { motion } from "motion/react";
import { Check, Folder, FolderPlus, Inbox, ShieldAlert } from "lucide-react";
import { SPAM_FOLDER, type Conversation } from "@/lib/relay";
import { Backdrop, dialogMotion } from "./motion";

/** Asks for a folder name (new folder or rename). */
export function NameDialog({ title, initial = "", taken, onSave, onClose }: {
  title: string; initial?: string; taken: string[]; onSave: (name: string) => void; onClose: () => void;
}) {
  const [name, setName] = useState(initial);
  const clean = name.trim();
  const error = clean.toLowerCase() === SPAM_FOLDER ? "“Spam” is built in" : clean !== initial && taken.includes(clean) ? "That folder already exists" : null;
  const save = () => { if (clean && !error) { onSave(clean); onClose(); } };
  return (
    <Backdrop onClick={onClose} className="grid place-items-center p-4">
      <motion.div {...dialogMotion} className="w-72 rounded-2xl border bg-popover p-4 shadow-soft" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold">{title}</h3>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="e.g. Work, Family, Bills"
          onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") onClose(); }}
          className="mt-3 w-full rounded-lg border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" />
        {error && <p className="mt-1 text-[11px] text-destructive">{error}</p>}
        <div className="mt-3 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted">Cancel</button>
          <button onClick={save} disabled={!clean || !!error} className="rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-40">Save</button>
        </div>
      </motion.div>
    </Backdrop>
  );
}

/**
 * "Move to…": Inbox, your folders, Spam, or a new folder. Number keys pick a row
 * (1 = Inbox, 2… = folders), so moving is two keystrokes: V then a number.
 */
export function MoveDialog({ targets, folders, onMove, onCreate, onClose }: {
  targets: Conversation[]; folders: string[]; onMove: (folder: string | null) => void; onCreate: (name: string) => void; onClose: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const current = new Set(targets.map((c) => c.folder));
  const here = (f: string | null) => current.size === 1 && current.has(f);
  const rows: { folder: string | null; label: string; icon: typeof Inbox }[] = [
    { folder: null, label: "Inbox", icon: Inbox },
    ...folders.map((f) => ({ folder: f, label: f, icon: Folder })),
    { folder: SPAM_FOLDER, label: "Spam", icon: ShieldAlert },
  ];
  const pick = (f: string | null) => { onMove(f); onClose(); };

  if (creating) {
    return <NameDialog title="New folder" taken={folders} onClose={onClose} onSave={(name) => { onCreate(name); onMove(name); }} />;
  }
  return (
    <Backdrop onClick={onClose} className="grid place-items-center p-4">
      <motion.div {...dialogMotion} tabIndex={-1} className="w-72 rounded-2xl border bg-popover p-2 shadow-soft outline-none" onClick={(e) => e.stopPropagation()}
        ref={(el) => el?.focus()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          const n = Number(e.key);
          if (n >= 1 && n <= rows.length && n <= 9) { e.preventDefault(); pick(rows[n - 1]!.folder); }
        }}>
        <p className="px-2 pb-1 pt-1.5 text-sm font-semibold">Move to…</p>
        <p className="px-2 pb-2 text-xs text-muted-foreground">{targets.length === 1 ? `“${targets[0]!.name}”` : `${targets.length} chats`}</p>
        <div className="max-h-72 overflow-y-auto">
          {rows.map((r, i) => (
            <button key={r.label} onClick={() => pick(r.folder)}
              className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-sm transition hover:bg-muted ${r.folder === SPAM_FOLDER ? "text-destructive" : ""}`}>
              <r.icon className="h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{r.label}</span>
              {here(r.folder) ? <Check className="h-3.5 w-3.5 text-primary" /> : i < 9 && <kbd className="rounded border px-1 text-[10px] text-muted-foreground">{i + 1}</kbd>}
            </button>
          ))}
        </div>
        <button onClick={() => setCreating(true)} className="mt-1 flex w-full items-center gap-2.5 rounded-lg border-t px-2 py-2 text-left text-sm text-primary hover:bg-muted">
          <FolderPlus className="h-4 w-4" /> New folder…
        </button>
      </motion.div>
    </Backdrop>
  );
}
