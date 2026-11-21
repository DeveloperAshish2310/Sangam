import { useState } from "react";
import { Loader2, ScanSearch, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/relay";

/** Top of the Spam view: what lands here, the filter switch, and a one-off scan of the Inbox. */
export function SpamNotice({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  const [scanning, setScanning] = useState(false);
  const scan = () => {
    setScanning(true);
    api<{ checked: number; moved: number }>("/spam/scan", { method: "POST" })
      .then(({ checked, moved }) => toast(moved ? `Moved ${moved} chat${moved > 1 ? "s" : ""} to Spam` : "No spam found", { description: `Checked ${checked} Inbox chats` }))
      .catch((e: Error) => toast.error(e.message))
      .finally(() => setScanning(false));
  };
  return (
    <div className="mx-3 mb-2 rounded-xl border bg-card p-3 text-xs">
      <p className="flex items-center gap-1.5 font-medium"><ShieldAlert className="h-3.5 w-3.5 text-destructive" /> Spam</p>
      <p className="mt-1 text-muted-foreground">
        Chats you marked as spam, and new senders whose messages look like scams. Saved contacts and people you've replied to are never moved here. Spam doesn't notify you.
      </p>
      <div className="mt-2 flex items-center justify-between gap-2">
        <button onClick={onToggle} aria-pressed={enabled} className="flex items-center gap-2 font-medium">
          <span className={`h-4 w-7 shrink-0 rounded-full p-0.5 transition ${enabled ? "bg-primary" : "bg-muted"}`}>
            <span className={`block h-3 w-3 rounded-full bg-card shadow transition ${enabled ? "translate-x-3" : ""}`} />
          </span>
          Filter new messages
        </button>
        <button onClick={scan} disabled={scanning} className="flex items-center gap-1 rounded-md px-2 py-1 font-medium text-primary hover:bg-muted disabled:opacity-60">
          {scanning ? <Loader2 className="h-3 w-3 animate-spin" /> : <ScanSearch className="h-3 w-3" />} Scan Inbox
        </button>
      </div>
    </div>
  );
}
