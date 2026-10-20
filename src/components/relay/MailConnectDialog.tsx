import { motion } from "motion/react";
import { Backdrop, dialogMotion } from "./motion";
import { useState } from "react";
import { AlertTriangle, AtSign, ChevronDown, Lock } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/relay";

type Server = { host: string; port: number; secure: boolean };
type Preset = { label: string; imap: Server; smtp: Server; note?: string; blocked?: boolean };

const ssl = (host: string, port = 993): Server => ({ host, port, secure: true });

const PROVIDERS: Preset[] = [
  { label: "Google Workspace", imap: ssl("imap.gmail.com"), smtp: ssl("smtp.gmail.com", 465), note: "Needs 2-Step Verification and an app password (myaccount.google.com/apppasswords)." },
  { label: "Zoho (India)", imap: ssl("imap.zoho.in"), smtp: ssl("smtp.zoho.in", 465), note: "Enable IMAP in Zoho Mail settings; use an app-specific password if 2FA is on." },
  { label: "Zoho", imap: ssl("imap.zoho.com"), smtp: ssl("smtp.zoho.com", 465) },
  { label: "Hostinger", imap: ssl("imap.hostinger.com"), smtp: ssl("smtp.hostinger.com", 465) },
  { label: "GoDaddy", imap: ssl("imap.secureserver.net"), smtp: ssl("smtpout.secureserver.net", 465) },
  { label: "Yahoo", imap: ssl("imap.mail.yahoo.com"), smtp: ssl("smtp.mail.yahoo.com", 465), note: "Yahoo requires an app password." },
  { label: "iCloud", imap: ssl("imap.mail.me.com"), smtp: { host: "smtp.mail.me.com", port: 587, secure: false }, note: "iCloud requires an app-specific password." },
  { label: "Microsoft 365 / Outlook", imap: ssl("outlook.office365.com"), smtp: { host: "smtp.office365.com", port: 587, secure: false }, blocked: true,
    note: "Microsoft blocks password sign-in for most accounts. A dedicated Microsoft connector is planned alongside Teams." },
];

const DOMAIN_PRESET: Record<string, string> = {
  "gmail.com": "Google Workspace", "googlemail.com": "Google Workspace", "zohomail.in": "Zoho (India)", "zoho.com": "Zoho",
  "yahoo.com": "Yahoo", "yahoo.in": "Yahoo", "icloud.com": "iCloud", "me.com": "iCloud", "mac.com": "iCloud",
  "outlook.com": "Microsoft 365 / Outlook", "hotmail.com": "Microsoft 365 / Outlook", "live.com": "Microsoft 365 / Outlook",
};

const guessFor = (domain: string): Preset => ({
  label: "Other",
  imap: ssl(`imap.${domain}`),
  smtp: ssl(`smtp.${domain}`, 465),
  note: "Server names guessed from your domain. Your email provider's help pages list the right ones.",
});

const input = "mt-1 w-full rounded-lg border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring";
const label = "text-[11px] font-semibold uppercase tracking-widest text-muted-foreground";

export function MailConnectDialog({ initialEmail, onClose }: { initialEmail?: string; onClose: () => void }) {
  const [email, setEmail] = useState(initialEmail ?? "");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [preset, setPreset] = useState<Preset | null>(null);
  const [imap, setImap] = useState<Server>(ssl(""));
  const [smtp, setSmtp] = useState<Server>(ssl("", 465));
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const domain = email.split("@")[1]?.toLowerCase() ?? "";

  const choose = (p: Preset) => {
    setPreset(p);
    setImap(p.imap);
    setSmtp(p.smtp);
  };

  // Fill servers from the email domain once it's typed, unless the user already picked a provider.
  const onEmailBlur = () => {
    if (preset || !domain.includes(".")) return;
    const known = PROVIDERS.find((p) => p.label === DOMAIN_PRESET[domain]);
    choose(known ?? guessFor(domain));
    if (!known) setAdvanced(true);
  };

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      await api("/connect/mail", { method: "POST", body: { email, name, password, imap, smtp } });
      toast.success("Work Mail connected — syncing your inbox…");
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const ready = email.includes("@") && password && imap.host && smtp.host && !preset?.blocked;

  return (
    <Backdrop onClick={onClose} className="grid place-items-center p-4">
      <motion.form {...dialogMotion}
        className="scrollbar-thin max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl border bg-popover p-5 shadow-soft"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); if (ready && !busy) void submit(); }}
      >
        <div className="flex items-center gap-3">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-mail"><AtSign className="h-4 w-4 text-primary-foreground" /></span>
          <div>
            <h3 className="font-semibold">Connect Work Mail</h3>
            <p className="text-xs text-muted-foreground">Any provider with IMAP and SMTP</p>
          </div>
        </div>

        <div className="mt-4 space-y-3">
          <label className="block"><span className={label}>Email</span>
            <input autoFocus type="email" value={email} onChange={(e) => setEmail(e.target.value)} onBlur={onEmailBlur} placeholder="you@company.com" className={input} />
          </label>
          <label className="block"><span className={label}>Your name (shown on replies)</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ashish" className={input} />
          </label>
          <label className="block"><span className={label}>Password or app password</span>
            <input type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} className={input} />
          </label>

          <div>
            <span className={label}>Provider</span>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {PROVIDERS.map((p) => (
                <button type="button" key={p.label} onClick={() => choose(p)}
                  className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${preset?.label === p.label ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground"}`}>
                  {p.label}
                </button>
              ))}
              {domain.includes(".") && (
                <button type="button" onClick={() => { choose(guessFor(domain)); setAdvanced(true); }}
                  className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${preset?.label === "Other" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-accent"}`}>
                  Other
                </button>
              )}
            </div>
            {preset?.note && (
              <p className={`mt-2 flex gap-1.5 text-xs ${preset.blocked ? "text-destructive" : "text-muted-foreground"}`}>
                {preset.blocked && <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}{preset.note}
              </p>
            )}
          </div>

          <button type="button" onClick={() => setAdvanced((v) => !v)} className="flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-xs">
            <span className="text-muted-foreground">
              {imap.host ? <>IMAP <b className="text-foreground">{imap.host}:{imap.port}</b> · SMTP <b className="text-foreground">{smtp.host}:{smtp.port}</b></> : "Server settings"}
            </span>
            <ChevronDown className={`h-4 w-4 transition ${advanced ? "rotate-180" : ""}`} />
          </button>
          {advanced && (
            <div className="space-y-3 rounded-lg border p-3">
              <ServerFields title="Incoming (IMAP)" value={imap} onChange={setImap} />
              <ServerFields title="Outgoing (SMTP)" value={smtp} onChange={setSmtp} />
            </div>
          )}
        </div>

        <p className="mt-3 flex items-start gap-1.5 text-[11px] text-muted-foreground">
          <Lock className="mt-0.5 h-3 w-3 shrink-0" /> Sangam always uses an encrypted connection, and stores the password encrypted on this PC.
        </p>
        {error && <p className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted">Cancel</button>
          <button type="submit" disabled={!ready || busy} className="rounded-lg bg-primary px-4 py-1.5 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-40">
            {busy ? "Checking sign-in…" : "Connect"}
          </button>
        </div>
      </motion.form>
    </Backdrop>
  );
}

function ServerFields({ title, value, onChange }: { title: string; value: Server; onChange: (s: Server) => void }) {
  return (
    <div>
      <p className="text-xs font-semibold">{title}</p>
      <div className="mt-1.5 flex gap-2">
        {/* Own width classes: the shared `input` style is w-full, which would squash the server box. */}
        <label className="min-w-0 flex-1">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Server</span>
          <input value={value.host} onChange={(e) => onChange({ ...value, host: e.target.value.trim() })} placeholder="mail.example.com" spellCheck={false}
            className="mt-0.5 w-full rounded-lg border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" />
        </label>
        <label className="w-24 shrink-0">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Port</span>
          <input type="number" inputMode="numeric" min={1} max={65535} value={value.port} onChange={(e) => onChange({ ...value, port: Number(e.target.value) })}
            className="mt-0.5 w-full rounded-lg border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" />
        </label>
      </div>
      <label className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
        <input type="checkbox" checked={value.secure} onChange={(e) => onChange({ ...value, secure: e.target.checked })} />
        SSL/TLS from the start (off = STARTTLS, still encrypted)
      </label>
    </div>
  );
}
