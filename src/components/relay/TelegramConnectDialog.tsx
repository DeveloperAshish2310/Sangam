import { motion } from "motion/react";
import { Backdrop, dialogMotion } from "./motion";
import { useState } from "react";
import { Lock, Send } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/relay";

type Step = { kind: "phone" } | { kind: "code"; loginId: string; viaApp: boolean } | { kind: "password"; loginId: string; hint: string | null };

const input = "mt-1 w-full rounded-lg border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring";
const label = "text-[11px] font-semibold uppercase tracking-widest text-muted-foreground";

export function TelegramConnectDialog({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<Step>({ kind: "phone" });
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      if (step.kind === "phone") {
        const r = await api<{ loginId: string; viaApp: boolean }>("/connect/telegram/start", { method: "POST", body: { phone: value } });
        setStep({ kind: "code", loginId: r.loginId, viaApp: r.viaApp });
      } else if (step.kind === "code") {
        const r = await api<{ ok?: boolean; needPassword?: boolean; hint?: string | null }>("/connect/telegram/code", { method: "POST", body: { loginId: step.loginId, code: value } });
        if (r.needPassword) {
          setStep({ kind: "password", loginId: step.loginId, hint: r.hint ?? null });
          setValue("");
          return;
        }
        done();
      } else {
        await api("/connect/telegram/password", { method: "POST", body: { loginId: step.loginId, password: value } });
        done();
      }
      if (step.kind === "phone") setValue("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const done = () => {
    toast.success("Telegram connected — syncing your chats…");
    onClose();
  };

  const field =
    step.kind === "phone" ? (
      <label className="block"><span className={label}>Phone number</span>
        <input autoFocus type="tel" autoComplete="tel" value={value} onChange={(e) => setValue(e.target.value)} placeholder="+91 98765 43210" className={input} />
      </label>
    ) : step.kind === "code" ? (
      <label className="block"><span className={label}>Login code</span>
        <input autoFocus inputMode="numeric" autoComplete="one-time-code" value={value} onChange={(e) => setValue(e.target.value.replace(/\D/g, ""))} maxLength={8} placeholder="12345" className={`${input} tracking-[0.3em]`} />
        <span className="mt-1.5 block text-xs text-muted-foreground">
          {step.viaApp ? "Telegram sent the code to your Telegram app (check the “Telegram” chat on your phone)." : "Telegram sent the code by SMS."}
        </span>
      </label>
    ) : (
      <label className="block"><span className={label}>Two-step verification password</span>
        <input autoFocus type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} className={input} />
        {step.hint && <span className="mt-1.5 block text-xs text-muted-foreground">Hint: {step.hint}</span>}
      </label>
    );

  return (
    <Backdrop onClick={onClose} className="grid place-items-center p-4">
      <motion.form {...dialogMotion} className="w-full max-w-sm rounded-2xl border bg-popover p-5 shadow-soft" onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); if (value && !busy) void submit(); }}>
        <div className="flex items-center gap-3">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-telegram"><Send className="h-4 w-4 text-primary-foreground" /></span>
          <div>
            <h3 className="font-semibold">Connect Telegram</h3>
            <p className="text-xs text-muted-foreground">Step {step.kind === "phone" ? 1 : step.kind === "code" ? 2 : 3} — signs in like a new Telegram device</p>
          </div>
        </div>
        <div className="mt-4">{field}</div>
        <p className="mt-3 flex items-start gap-1.5 text-[11px] text-muted-foreground">
          <Lock className="mt-0.5 h-3 w-3 shrink-0" />
          Sangam appears in Telegram → Settings → Devices as “Sangam (this PC)”. Its session is stored encrypted on this PC; end it there anytime.
        </p>
        {error && <p className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted">Cancel</button>
          <button type="submit" disabled={!value || busy} className="rounded-lg bg-primary px-4 py-1.5 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-40">
            {busy ? "Please wait…" : step.kind === "phone" ? "Send code" : "Sign in"}
          </button>
        </div>
      </motion.form>
    </Backdrop>
  );
}
