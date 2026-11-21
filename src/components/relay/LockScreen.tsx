import { useState } from "react";
import { motion } from "motion/react";
import { Loader2, Lock, LogOut } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { api, type User } from "@/lib/relay";
import { initials } from "./common";
import { dialogMotion } from "./motion";

/**
 * App lock: shown instead of the inbox while this session is locked. The server refuses every
 * request until the password is entered, so nothing behind this screen can be loaded.
 */
export function LockScreen({ user }: { user: User }) {
  const qc = useQueryClient();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const unlock = async () => {
    setBusy(true);
    setError("");
    try {
      await api("/auth/unlock", { method: "POST", body: { password } });
      await qc.invalidateQueries();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPassword("");
    } finally {
      setBusy(false);
    }
  };
  const signOut = async () => {
    await api("/auth/logout", { method: "POST" }).catch(() => {});
    qc.clear();
    await qc.invalidateQueries();
  };

  return (
    <div className="grid h-screen place-items-center bg-background p-6">
      <motion.form {...dialogMotion} onSubmit={(e) => { e.preventDefault(); void unlock(); }}
        className="flex w-full max-w-xs flex-col items-center rounded-3xl border bg-card p-8 text-center shadow-soft">
        <div className="grid h-16 w-16 place-items-center rounded-full bg-accent text-xl font-semibold text-accent-foreground">{initials(user.name)}</div>
        <p className="mt-3 font-semibold">{user.name}</p>
        <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground"><Lock className="h-3 w-3" /> Sangam is locked</p>
        <input autoFocus type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" placeholder="Sangam password"
          className="mt-5 w-full rounded-xl border bg-background px-3 py-2.5 text-center text-sm outline-none focus:ring-2 focus:ring-ring" />
        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
        <button type="submit" disabled={!password || busy}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-primary py-2.5 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-40">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />} Unlock
        </button>
        <button type="button" onClick={() => void signOut()} className="mt-4 flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
          <LogOut className="h-3 w-3" /> Sign out
        </button>
      </motion.form>
    </div>
  );
}
