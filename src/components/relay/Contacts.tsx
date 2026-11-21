import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { motion } from "motion/react";
import { BookUser, Mail, MessageSquarePlus, Phone, Plus, Search, Trash2, UserRound } from "lucide-react";
import { toast } from "sonner";
import { useContacts } from "@/hooks/use-relay";
import { api, type Contact, type Conversation } from "@/lib/relay";
import { Avatar, avatarUrl, initials, SectionLabel, SlideOver } from "./common";
import { Backdrop, dialogMotion } from "./motion";

const input = "mt-1 w-full rounded-lg border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring";
const label = "text-[11px] font-semibold uppercase tracking-widest text-muted-foreground";

export type ContactDraft = { id?: number; name: string; phone: string; email: string; notes: string; conversationId?: number };

/** Add or edit a contact. Saving from a chat also ties that chat to the contact. */
export function ContactDialog({ initial, onClose }: { initial: ContactDraft; onClose: () => void }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (patch: Partial<ContactDraft>) => setDraft((d) => ({ ...d, ...patch }));

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const body = { name: draft.name, phone: draft.phone || null, email: draft.email || null, notes: draft.notes };
      if (draft.id) await api(`/contacts/${draft.id}`, { method: "PATCH", body });
      else await api("/contacts", { method: "POST", body: { ...body, ...(draft.conversationId && { conversationId: draft.conversationId }) } });
      await qc.invalidateQueries();
      toast.success(draft.id ? "Contact updated" : `Saved ${draft.name}`);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!draft.id || !window.confirm(`Delete ${draft.name} from Sangam's contacts? Chats and messages stay.`)) return;
    await api(`/contacts/${draft.id}`, { method: "DELETE" }).catch((e: Error) => toast.error(e.message));
    await qc.invalidateQueries();
    onClose();
  };

  return (
    <Backdrop onClick={onClose} className="grid place-items-center p-4" z="z-[55]">
      <motion.form {...dialogMotion} className="w-full max-w-sm rounded-2xl border bg-popover p-5 shadow-soft" onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); if (draft.name.trim() && !busy) void save(); }}>
        <div className="flex items-center gap-3">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-primary text-primary-foreground"><UserRound className="h-4 w-4" /></span>
          <div>
            <h3 className="font-semibold">{draft.id ? "Edit contact" : "Save contact"}</h3>
            <p className="text-xs text-muted-foreground">Saved in Sangam only — your phone's contacts aren't changed</p>
          </div>
        </div>
        <div className="mt-4 space-y-3">
          <label className="block"><span className={label}>Name</span>
            <input autoFocus value={draft.name} onChange={(e) => set({ name: e.target.value })} maxLength={120} className={input} />
          </label>
          <label className="block"><span className={label}>Phone (with country code)</span>
            <input type="tel" value={draft.phone} onChange={(e) => set({ phone: e.target.value })} placeholder="+91 98765 43210" className={input} />
          </label>
          <label className="block"><span className={label}>Email</span>
            <input type="email" value={draft.email} onChange={(e) => set({ email: e.target.value })} placeholder="name@example.com" className={input} />
          </label>
          <label className="block"><span className={label}>Notes</span>
            <textarea value={draft.notes} onChange={(e) => set({ notes: e.target.value })} rows={3} maxLength={2000} placeholder="e.g. Client at Acme, prefers WhatsApp" className={`${input} resize-y`} />
          </label>
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">Chats with this phone number or email are recognised automatically.</p>
        {error && <p className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
        <div className="mt-4 flex items-center justify-between gap-2">
          {draft.id ? (
            <button type="button" onClick={() => void remove()} className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm font-medium text-destructive hover:bg-muted">
              <Trash2 className="h-4 w-4" /> Delete
            </button>
          ) : <span />}
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted">Cancel</button>
            <button type="submit" disabled={!draft.name.trim() || busy} className="rounded-lg bg-primary px-4 py-1.5 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-40">
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </motion.form>
    </Backdrop>
  );
}

const draftFor = (c: Contact): ContactDraft => ({ id: c.id, name: c.name, phone: c.phone ? `+${c.phone}` : "", email: c.email ?? "", notes: c.notes });

/** The address book: search, add, edit, and jump to a contact's chats or message them. */
export function ContactsPanel({ convos, onOpenChat, onMessage, onEdit, onClose }: {
  convos: Conversation[];
  onOpenChat: (id: number) => void;
  onMessage: (contact: Contact) => void;
  onEdit: (draft: ContactDraft) => void;
  onClose: () => void;
}) {
  const { data: contacts = [], isLoading } = useContacts();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? contacts.filter((c) => [c.name, c.phone, c.email, c.notes].some((v) => v?.toLowerCase().includes(q))) : contacts;
  }, [contacts, query]);

  return (
    <SlideOver title="Contacts" onClose={onClose}>
      <div className="mt-4 flex gap-2">
        <div className="flex flex-1 items-center gap-2 rounded-xl border bg-card px-3 py-2">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search contacts…" className="flex-1 bg-transparent text-sm outline-none" />
        </div>
        <button onClick={() => onEdit({ name: "", phone: "", email: "", notes: "" })} title="New contact"
          className="grid h-10 w-10 place-items-center rounded-xl bg-primary text-primary-foreground transition hover:opacity-90"><Plus className="h-4 w-4" /></button>
      </div>
      <SectionLabel>{contacts.length} contact{contacts.length === 1 ? "" : "s"}</SectionLabel>
      {!isLoading && contacts.length === 0 && (
        <div className="mt-6 text-center text-sm text-muted-foreground">
          <BookUser className="mx-auto h-8 w-8 opacity-50" />
          <p className="mt-2">No contacts yet.</p>
          <p className="text-xs">Open a chat → Contact info → <b>Save contact</b>, or press <b>+</b>.</p>
        </div>
      )}
      <div className="mt-2 space-y-1">
        {shown.map((c) => {
          const chats = convos.filter((v) => c.conversationIds.includes(v.id));
          const expanded = open === c.id;
          return (
            <div key={c.id} className={`rounded-xl border transition-colors ${expanded ? "bg-card" : "border-transparent hover:bg-muted/60"}`}>
              <button onClick={() => setOpen(expanded ? null : c.id)} className="flex w-full items-center gap-3 p-2.5 text-left">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-secondary font-display text-sm font-semibold text-secondary-foreground">{initials(c.name)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{c.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{[c.phone && `+${c.phone}`, c.email].filter(Boolean).join(" · ") || "No phone or email"}</span>
                </span>
                {chats.length > 0 && <span className="text-[11px] text-muted-foreground">{chats.length} chat{chats.length === 1 ? "" : "s"}</span>}
              </button>
              {expanded && (
                <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} className="overflow-hidden px-2.5 pb-2.5">
                  {c.phone && <p className="flex items-center gap-2 text-xs text-muted-foreground"><Phone className="h-3 w-3" /> +{c.phone}</p>}
                  {c.email && <p className="mt-1 flex items-center gap-2 text-xs text-muted-foreground"><Mail className="h-3 w-3" /> {c.email}</p>}
                  {c.notes && <p className="mt-2 whitespace-pre-wrap rounded-lg bg-muted px-2.5 py-1.5 text-xs">{c.notes}</p>}
                  {chats.length > 0 && (
                    <div className="mt-2 space-y-1">
                      {chats.map((v) => (
                        <button key={v.id} onClick={() => onOpenChat(v.id)} className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left text-xs hover:bg-muted">
                          <Avatar name={v.name} channel={v.channel} photo={avatarUrl(v)} />
                          <span className="min-w-0 flex-1 truncate">{v.subject ?? v.serviceName ?? v.name}</span>
                          <span className="text-primary">Open</span>
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="mt-2 flex gap-2">
                    {(c.phone || c.email) && (
                      <button onClick={() => onMessage(c)} className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90">
                        <MessageSquarePlus className="h-3.5 w-3.5" /> Message
                      </button>
                    )}
                    <button onClick={() => onEdit(draftFor(c))} className="rounded-lg border px-3 py-1.5 text-xs font-medium hover:bg-muted">Edit</button>
                  </div>
                </motion.div>
              )}
            </div>
          );
        })}
      </div>
    </SlideOver>
  );
}

export { draftFor };
