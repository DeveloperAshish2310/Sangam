import { motion } from "motion/react";
import { Backdrop, dialogMotion } from "./motion";
import { useCallback, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CaseSensitive, MessageSquarePlus, Send, UserRound } from "lucide-react";
import { toast } from "sonner";
import { keys, useContacts, useSettings } from "@/hooks/use-relay";
import { api, ch, type Account, type ChannelId, type Conversation } from "@/lib/relay";
import { Avatar, avatarUrl } from "./common";
import { RichComposer, type ComposerHandle } from "./RichComposer";
import { outgoingFor, signatureApplies, withSignature } from "@/lib/formatting";

const input = "mt-1 w-full rounded-lg border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring";
const label = "text-[11px] font-semibold uppercase tracking-widest text-muted-foreground";

const isEmail = (a: Account) => a.channel === "gmail" || a.channel === "mail";

/** Start a brand-new conversation from any connected account. */
export function ComposeDialog({ accounts, convos, onOpen, onClose, initialTo, preferChannels }: {
  accounts: Account[];
  convos: Conversation[];
  /** Pre-filled recipient (e.g. "Message" from a saved contact). */
  initialTo?: string;
  /** Pick the first connected account on one of these channels. */
  preferChannels?: ChannelId[];
  onOpen: (conversationId: number) => void;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const usable = accounts.filter((a) => a.status === "connected");
  const preferred = preferChannels?.flatMap((ch) => usable.filter((a) => a.channel === ch))[0];
  const [accountId, setAccountId] = useState((preferred ?? usable[0])?.id ?? 0);
  const [to, setTo] = useState(initialTo ?? "");
  const { data: contacts = [] } = useContacts();
  const { settings } = useSettings(true);
  const [subject, setSubject] = useState("");
  // `text` mirrors the editor's plain text (to enable Send); the formatted content is read on send.
  const [text, setText] = useState("");
  const onTextChange = useCallback((t: string) => setText(t), []);
  const composer = useRef<ComposerHandle>(null);
  const [toolbar, setToolbar] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const account = usable.find((a) => a.id === accountId);

  // Already talking to them on this account? Offer to open that chat instead of starting a new one.
  const existing = useMemo(() => {
    const q = to.trim().replace(/^@/, "").toLowerCase();
    if (q.length < 2) return [];
    return convos.filter((c) => c.accountId === accountId && c.name.toLowerCase().includes(q)).slice(0, 4);
  }, [to, convos, accountId]);

  const submit = async () => {
    if (!account) return;
    setBusy(true);
    setError("");
    try {
      // Converted to what the chosen channel understands (WhatsApp markers, Telegram/email HTML).
      const content = composer.current?.getHtml() ?? "";
      const out = outgoingFor(account.channel, signatureApplies(account.channel, text, settings) ? withSignature(content, settings!.signature) : content);
      const { conversationId } = await api<{ conversationId: number }>("/compose", {
        method: "POST",
        body: { accountId, to: to.trim(), text: out.text, ...(out.html && { html: out.html }), ...(isEmail(account) && subject.trim() && { subject: subject.trim() }) },
      });
      await qc.invalidateQueries({ queryKey: keys.conversations });
      toast.success(`Sent via ${ch(account.channel).name}`);
      onOpen(conversationId);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Saved contacts whose name matches, with the phone or email that suits this account's channel.
  const contactHits = useMemo(() => {
    const q = to.trim().toLowerCase();
    if (!account || q.length < 2) return [];
    return contacts
      .filter((p) => p.name.toLowerCase().includes(q))
      .map((p) => ({ p, value: isEmail(account) ? p.email : p.phone ? `+${p.phone}` : null }))
      .filter((x): x is { p: typeof x.p; value: string } => !!x.value && x.value !== to)
      .slice(0, 4);
  }, [to, contacts, account]);

  const placeholder = !account ? "" : isEmail(account) ? "name@example.com" : account.channel === "whatsapp" ? "+91 98765 43210" : "@username or +91 98765 43210";

  return (
    <Backdrop onClick={onClose} className="grid place-items-center p-4">
      <motion.form id="compose-form" {...dialogMotion} className="scrollbar-thin max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border bg-popover p-5 shadow-soft" onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); if (account && to.trim() && text.trim() && !busy) void submit(); }}>
        <div className="flex items-center gap-3">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-primary text-primary-foreground"><MessageSquarePlus className="h-4 w-4" /></span>
          <div>
            <h3 className="font-semibold">New message</h3>
            <p className="text-xs text-muted-foreground">Start a conversation from any connected account</p>
          </div>
        </div>

        {usable.length === 0 ? (
          <p className="mt-4 rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">Connect an account first (Profile → Connect).</p>
        ) : (
          <div className="mt-4 space-y-3">
            <div>
              <span className={label}>Send from</span>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {usable.map((a) => {
                  const C = ch(a.channel);
                  return (
                    <button type="button" key={a.id} onClick={() => { setAccountId(a.id); setError(""); }}
                      className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition ${a.id === accountId ? "border-primary bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted"}`}>
                      <span className={`grid h-4 w-4 place-items-center rounded-full ${C.bg}`}><C.icon className="h-2.5 w-2.5 text-primary-foreground" /></span>
                      {a.displayName}
                    </button>
                  );
                })}
              </div>
            </div>

            <label className="block"><span className={label}>To</span>
              <input autoFocus value={to} onChange={(e) => { setTo(e.target.value); setError(""); }} placeholder={placeholder} spellCheck={false}
                type={account && isEmail(account) ? "email" : "text"} className={input} />
            </label>
            {account?.channel === "telegram" && (
              <p className="-mt-1.5 text-[11px] text-muted-foreground">A phone number only works if that person lets others find them by number; a @username always works.</p>
            )}
            {contactHits.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {contactHits.map(({ p, value }) => (
                  <button type="button" key={p.id} onClick={() => setTo(value)}
                    className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs hover:bg-muted">
                    <UserRound className="h-3 w-3" /> <b>{p.name}</b> <span className="text-muted-foreground">{value}</span>
                  </button>
                ))}
              </div>
            )}
            {existing.length > 0 && (
              <div className="rounded-lg border">
                <p className="px-3 pt-2 text-[11px] text-muted-foreground">Already chatting on this account:</p>
                {existing.map((c) => (
                  <button type="button" key={c.id} onClick={() => { onOpen(c.id); onClose(); }}
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition hover:bg-muted">
                    <Avatar name={c.name} channel={c.channel} photo={avatarUrl(c)} />
                    <span className="min-w-0 flex-1 truncate">{c.name}</span>
                    <span className="text-xs text-primary">Open chat</span>
                  </button>
                ))}
              </div>
            )}

            {account && isEmail(account) && (
              <label className="block"><span className={label}>Subject</span>
                <input value={subject} onChange={(e) => setSubject(e.target.value)} className={input} />
              </label>
            )}

            <div>
              <div className="flex items-center justify-between">
                <span className={label}>Message</span>
                <button type="button" onClick={() => setToolbar((v) => !v)} aria-pressed={toolbar}
                  title={toolbar ? "Hide formatting" : `Formatting (what ${account ? ch(account.channel).name : "this app"} supports)`}
                  className={`grid h-6 w-6 place-items-center rounded-md hover:bg-muted ${toolbar ? "text-primary" : "text-muted-foreground"}`}><CaseSensitive className="h-4 w-4" /></button>
              </div>
              <div className="mt-1 rounded-lg border bg-card px-3 py-1.5 focus-within:ring-2 focus-within:ring-ring">
                {account && (
                  <RichComposer ref={composer} channel={account.channel} placeholder="Write your message…" showToolbar={toolbar} submitOn="ctrl-enter"
                    className="max-h-64 min-h-[7.5rem]" onChange={onTextChange} onSubmit={() => (document.getElementById("compose-form") as HTMLFormElement | null)?.requestSubmit()} />
                )}
              </div>
            </div>
          </div>
        )}

        {error && <p className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
        <div className="mt-4 flex items-center justify-between gap-2">
          <span className="text-[11px] text-muted-foreground">Ctrl + Enter to send</span>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted">Cancel</button>
            <button type="submit" disabled={!account || !to.trim() || !text.trim() || busy}
              className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-1.5 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-40">
              {busy ? "Sending…" : <>Send <Send className="h-3.5 w-3.5" /></>}
            </button>
          </div>
        </div>
      </motion.form>
    </Backdrop>
  );
}
