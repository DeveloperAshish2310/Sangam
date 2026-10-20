import { motion } from "motion/react";
import { Backdrop, dialogMotion } from "./motion";
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { MessageSquarePlus, Send } from "lucide-react";
import { toast } from "sonner";
import { keys } from "@/hooks/use-relay";
import { api, ch, type Account, type Conversation } from "@/lib/relay";
import { Avatar, avatarUrl } from "./common";

const input = "mt-1 w-full rounded-lg border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring";
const label = "text-[11px] font-semibold uppercase tracking-widest text-muted-foreground";

const isEmail = (a: Account) => a.channel === "gmail" || a.channel === "mail";

/** Start a brand-new conversation from any connected account. */
export function ComposeDialog({ accounts, convos, onOpen, onClose }: {
  accounts: Account[];
  convos: Conversation[];
  onOpen: (conversationId: number) => void;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const usable = accounts.filter((a) => a.status === "connected");
  const [accountId, setAccountId] = useState(usable[0]?.id ?? 0);
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");
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
      const { conversationId } = await api<{ conversationId: number }>("/compose", {
        method: "POST",
        body: { accountId, to: to.trim(), text, ...(isEmail(account) && subject.trim() && { subject: subject.trim() }) },
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

  const placeholder = !account ? "" : isEmail(account) ? "name@example.com" : account.channel === "whatsapp" ? "+91 98765 43210" : "@username or +91 98765 43210";

  return (
    <Backdrop onClick={onClose} className="grid place-items-center p-4">
      <motion.form {...dialogMotion} className="scrollbar-thin max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border bg-popover p-5 shadow-soft" onClick={(e) => e.stopPropagation()}
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

            <label className="block"><span className={label}>Message</span>
              <textarea value={text} onChange={(e) => setText(e.target.value)} rows={5}
                onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }}
                className={`${input} resize-y`} />
            </label>
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
