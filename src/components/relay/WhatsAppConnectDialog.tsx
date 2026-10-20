import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { AlertTriangle, Check, Loader2, MessageCircle, QrCode, Smartphone } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/relay";
import { Backdrop, dialogMotion } from "./motion";

type Status = { state: "starting" | "qr" | "code" | "connected" | "error"; qr: string | null; code: string | null; error: string | null };

const input = "mt-1 w-full rounded-lg border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring";

/** Links a WhatsApp number as a device of Sangam — by QR scan or by a pairing code typed on the phone. */
export function WhatsAppConnectDialog({ onClose }: { onClose: () => void }) {
  const [method, setMethod] = useState<"qr" | "code">("qr");
  const [phone, setPhone] = useState("");
  const [loginId, setLoginId] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const loginRef = useRef<string | null>(null);
  loginRef.current = loginId;

  // Poll the linking session; the QR code refreshes every ~20s on WhatsApp's side.
  useEffect(() => {
    if (!loginId) return undefined;
    let alive = true;
    const tick = async () => {
      const s = await api<Status>(`/connect/whatsapp/status/${loginId}`).catch(() => null);
      if (!alive || !s) return;
      setStatus(s);
      if (s.state === "connected") {
        toast.success("WhatsApp linked — syncing your chats…");
        onClose();
      }
    };
    void tick();
    const t = setInterval(() => void tick(), 1500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [loginId, onClose]);

  // Closing the dialog mid-way cancels the linking session on the server.
  useEffect(() => () => {
    if (loginRef.current) void api(`/connect/whatsapp/cancel/${loginRef.current}`, { method: "POST" }).catch(() => {});
  }, []);

  const start = async () => {
    setBusy(true);
    setError("");
    setStatus(null);
    try {
      const { loginId: id } = await api<{ loginId: string }>("/connect/whatsapp/start", { method: "POST", body: { method, ...(method === "code" && { phone }) } });
      setLoginId(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const restart = () => {
    setLoginId(null);
    setStatus(null);
  };

  return (
    <Backdrop onClick={onClose} className="grid place-items-center p-4">
      <motion.div {...dialogMotion} className="scrollbar-thin max-h-[92vh] w-full max-w-md overflow-y-auto rounded-2xl border bg-popover p-5 shadow-soft" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-whatsapp"><MessageCircle className="h-4 w-4 text-primary-foreground" /></span>
          <div>
            <h3 className="font-semibold">Link WhatsApp</h3>
            <p className="text-xs text-muted-foreground">Sangam joins as a linked device, like WhatsApp Web</p>
          </div>
        </div>

        <div className="mt-4 flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <p>
            This uses an <b>unofficial</b> WhatsApp connection. WhatsApp can ban numbers that use one —
            <b> use a spare number</b>, not your main one, until you&apos;re comfortable with the risk.
          </p>
        </div>

        {!loginId ? (
          <>
            <div className="mt-4 grid grid-cols-2 gap-2">
              {([
                { id: "qr", label: "Scan QR code", icon: QrCode },
                { id: "code", label: "Phone number", icon: Smartphone },
              ] as const).map((m) => (
                <button key={m.id} onClick={() => setMethod(m.id)}
                  className={`flex items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-sm font-medium transition-colors ${method === m.id ? "border-primary bg-accent text-accent-foreground" : "hover:bg-muted"}`}>
                  <m.icon className="h-4 w-4" /> {m.label}
                </button>
              ))}
            </div>
            {method === "code" && (
              <label className="mt-3 block">
                <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">WhatsApp number</span>
                <input autoFocus type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91 98765 43210" className={input} />
              </label>
            )}
            {error && <p className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted">Cancel</button>
              <button onClick={() => void start()} disabled={busy || (method === "code" && phone.replace(/\D/g, "").length < 8)}
                className="rounded-lg bg-primary px-4 py-1.5 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-40">
                {busy ? "Starting…" : method === "qr" ? "Show QR code" : "Get pairing code"}
              </button>
            </div>
          </>
        ) : (
          <div className="mt-4">
            {(!status || status.state === "starting") && (
              <p className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Connecting to WhatsApp…</p>
            )}
            {status?.state === "qr" && status.qr && (
              <div className="flex flex-col items-center">
                <motion.img key={status.qr} initial={{ opacity: 0.4 }} animate={{ opacity: 1 }} src={status.qr} alt="WhatsApp QR code" className="h-64 w-64 rounded-xl bg-white p-2" />
                <Steps last="Point your phone at this code" />
              </div>
            )}
            {status?.state === "code" && status.code && (
              <div className="flex flex-col items-center">
                <p className="rounded-xl border bg-card px-5 py-3 font-mono text-3xl font-bold tracking-[0.25em]">{status.code.slice(0, 4)}-{status.code.slice(4)}</p>
                <Steps last={<>Tap <b>Link with phone number instead</b> and enter this code</>} />
              </div>
            )}
            {status?.state === "connected" && <p className="flex items-center justify-center gap-2 py-12 text-sm text-whatsapp"><Check className="h-4 w-4" /> Linked!</p>}
            {status?.state === "error" && (
              <div className="py-6 text-center">
                <p className="text-sm text-destructive">{status.error}</p>
                <button onClick={restart} className="mt-3 rounded-lg bg-primary px-4 py-1.5 text-sm font-semibold text-primary-foreground">Start again</button>
              </div>
            )}
            <div className="mt-4 flex justify-end">
              <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted">Cancel</button>
            </div>
          </div>
        )}
      </motion.div>
    </Backdrop>
  );
}

function Steps({ last }: { last: React.ReactNode }) {
  return (
    <ol className="mt-4 list-decimal space-y-1 pl-5 text-left text-sm text-muted-foreground">
      <li>Open <b>WhatsApp</b> on the phone with that number</li>
      <li>Go to <b>Settings → Linked devices → Link a device</b></li>
      <li>{last}</li>
    </ol>
  );
}
