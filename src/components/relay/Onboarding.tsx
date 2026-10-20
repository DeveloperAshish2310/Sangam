import { useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Lock, Sparkles } from "lucide-react";
import { keys } from "@/hooks/use-relay";
import { api, CHANNELS, DEFAULT_SETTINGS, type Account, type ChannelId, type Settings, type User } from "@/lib/relay";
import { ThemePicker } from "./Panels";

const STEPS = ["Welcome", "Profile", "Channels", "Theme"];

function Card({ step, children }: { step?: number; children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6 transition-colors">
      <div className="w-full max-w-lg rounded-3xl border bg-surface p-8 shadow-soft">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="grid h-9 w-9 place-items-center rounded-xl bg-primary text-primary-foreground"><Sparkles className="h-5 w-5" /></div>
            <span className="font-display text-xl font-semibold">Sangam</span>
          </div>
          {step !== undefined && (
            <div className="flex gap-1.5">
              {STEPS.map((_, i) => (
                <span key={i} className={`h-1.5 rounded-full transition-all ${i === step ? "w-6 bg-primary" : i < step ? "w-1.5 bg-primary/50" : "w-1.5 bg-muted"}`} />
              ))}
            </div>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}

export function Splash() {
  return (
    <div className="grid min-h-screen place-items-center bg-background">
      <motion.div className="grid h-12 w-12 place-items-center rounded-2xl bg-primary text-primary-foreground"
        animate={{ scale: [1, 1.08, 1], rotate: [0, 6, -6, 0] }} transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}>
        <Sparkles className="h-6 w-6" />
      </motion.div>
    </div>
  );
}

const inputClass = "mt-1.5 w-full rounded-xl border bg-card px-4 py-3 text-sm outline-none focus:border-primary";
const primaryBtn = "rounded-xl bg-primary px-6 py-2.5 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-40";
const backBtn = "rounded-xl px-5 py-2.5 text-sm font-medium text-muted-foreground transition hover:bg-muted";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

type WizardProps = {
  user: User | null;
  settings: Settings | undefined;
  accounts: Account[];
  step: number;
  onStep: (step: number) => void;
  update: (patch: Partial<Settings>) => void;
};

export function SetupWizard({ user, settings, accounts, step, onStep, update }: WizardProps) {
  const qc = useQueryClient();
  const current = settings ?? DEFAULT_SETTINGS;
  const [name, setName] = useState(user?.name ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [channels, setChannels] = useState<ChannelId[]>(current.channels);
  const [demo, setDemo] = useState(accounts.length === 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  const saveProfile = () =>
    run(async () => {
      if (user) await api("/me", { method: "PATCH", body: { name, email } });
      else await api("/auth/register", { method: "POST", body: { name, email, password } });
      await qc.invalidateQueries({ queryKey: keys.auth });
      onStep(2);
    });

  const saveChannels = () =>
    run(async () => {
      update({ channels });
      const hasDemo = accounts.some((a) => a.status === "demo");
      if (demo && !hasDemo) await api("/demo", { method: "POST" });
      if (!demo && hasDemo) await api("/demo", { method: "DELETE" });
      onStep(3);
    });

  const finish = () => { update({ setupDone: true }); onStep(0); };
  const passwordProblem = !user && (password.length < 8 ? "At least 8 characters" : password !== confirm ? "Passwords don't match" : "");

  return (
    <Card step={step}>
      {/* Each step slides in from the right and out to the left. */}
      <AnimatePresence mode="wait" initial={false}>
      <motion.div key={step} initial={{ opacity: 0, x: 28 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -28 }} transition={{ duration: 0.22, ease: "easeOut" }}>
      {step === 0 && (
        <div className="mt-10 text-center">
          <div className="mx-auto flex w-fit -space-x-2">
            {CHANNELS.map((c) => (
              <span key={c.id} className={`grid h-12 w-12 place-items-center rounded-full ring-4 ring-surface ${c.bg}`}><c.icon className="h-5 w-5 text-primary-foreground" /></span>
            ))}
          </div>
          <h1 className="mt-6 font-display text-3xl font-semibold">Every channel, one inbox</h1>
          <p className="mx-auto mt-3 max-w-sm text-sm leading-relaxed text-muted-foreground">
            WhatsApp, Telegram, Teams, Gmail and more — read and reply to everything from a single clean dashboard.
          </p>
          <button onClick={() => onStep(1)} className="mt-8 rounded-xl bg-primary px-8 py-3 text-sm font-semibold text-primary-foreground shadow-soft transition hover:opacity-90">
            Get started
          </button>
        </div>
      )}

      {step === 1 && (
        <div className="mt-8">
          <h1 className="font-display text-2xl font-semibold">Your profile</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {user ? "This is how you'll appear in Sangam." : "Sangam keeps your messages on this PC. A password protects them."}
          </p>
          <div className="mt-5 space-y-3">
            <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" className={inputClass} /></Field>
            <Field label="Email"><input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" type="email" className={inputClass} /></Field>
            {!user && (
              <>
                <Field label="Password"><input value={password} onChange={(e) => setPassword(e.target.value)} type="password" autoComplete="new-password" placeholder="At least 8 characters" className={inputClass} /></Field>
                <Field label="Confirm password"><input value={confirm} onChange={(e) => setConfirm(e.target.value)} type="password" autoComplete="new-password" className={inputClass} /></Field>
                {password && passwordProblem && <p className="text-xs text-destructive">{passwordProblem}</p>}
              </>
            )}
          </div>
          {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
          <div className="mt-6 flex justify-between">
            <button onClick={() => onStep(0)} className={backBtn}>Back</button>
            <button onClick={saveProfile} disabled={!name.trim() || !!passwordProblem || busy} className={primaryBtn}>Continue</button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="mt-8">
          <h1 className="font-display text-2xl font-semibold">Choose your channels</h1>
          <p className="mt-1 text-sm text-muted-foreground">Pick the channels to show. You'll sign in to each one as it gets connected.</p>
          <div className="mt-5 space-y-2">
            {CHANNELS.map((c) => {
              const on = channels.includes(c.id);
              return (
                <button key={c.id} onClick={() => setChannels((s) => (on ? s.filter((x) => x !== c.id) : [...s, c.id]))}
                  className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left transition ${on ? "border-primary/40 bg-accent" : "opacity-60 hover:opacity-100"}`}>
                  <span className={`grid h-10 w-10 place-items-center rounded-lg ${c.bg}`}><c.icon className="h-4 w-4 text-primary-foreground" /></span>
                  <span className="flex-1 text-sm font-medium">{c.name}</span>
                  <span className={`grid h-6 w-6 place-items-center rounded-full border transition ${on ? "border-primary bg-primary text-primary-foreground" : "text-transparent"}`}><Check className="h-3.5 w-3.5" /></span>
                </button>
              );
            })}
          </div>
          <label className="mt-4 flex cursor-pointer items-center gap-2.5 rounded-xl border p-3 text-sm">
            <input type="checkbox" checked={demo} onChange={(e) => setDemo(e.target.checked)} className="h-4 w-4 accent-[var(--primary)]" />
            <span><span className="font-medium">Fill the inbox with demo conversations</span><span className="block text-xs text-muted-foreground">Remove them anytime in Settings.</span></span>
          </label>
          {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
          <div className="mt-6 flex justify-between">
            <button onClick={() => onStep(1)} className={backBtn}>Back</button>
            <button onClick={saveChannels} disabled={!channels.length || busy} className={primaryBtn}>Continue</button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="mt-8">
          <h1 className="font-display text-2xl font-semibold">Make it yours</h1>
          <p className="mt-1 text-sm text-muted-foreground">Choose a theme and background — change anytime in Settings.</p>
          <ThemePicker settings={current} update={update} large />
          <div className="mt-6 flex justify-between">
            <button onClick={() => onStep(2)} className={backBtn}>Back</button>
            <button onClick={finish} className={`${primaryBtn} shadow-soft`}>Open my inbox</button>
          </div>
        </div>
      )}

      </motion.div>
      </AnimatePresence>

      {user && step > 1 && (
        <button onClick={finish} className="mt-4 w-full text-center text-xs text-muted-foreground transition hover:text-foreground">Skip setup</button>
      )}
    </Card>
  );
}

export function LoginScreen() {
  const qc = useQueryClient();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      await api("/auth/login", { method: "POST", body: { password } });
      await qc.invalidateQueries();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <div className="mt-8">
        <h1 className="font-display text-2xl font-semibold">Welcome back</h1>
        <p className="mt-1 text-sm text-muted-foreground">Enter your Sangam password to unlock your inbox.</p>
        <form className="mt-5" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <Field label="Password">
            <input autoFocus value={password} onChange={(e) => setPassword(e.target.value)} type="password" autoComplete="current-password" className={inputClass} />
          </Field>
          {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
          <button type="submit" disabled={!password || busy} className={`${primaryBtn} mt-6 flex w-full items-center justify-center gap-2`}>
            <Lock className="h-4 w-4" /> Unlock
          </button>
        </form>
      </div>
    </Card>
  );
}
