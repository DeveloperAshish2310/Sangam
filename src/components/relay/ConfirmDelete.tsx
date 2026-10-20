import { AnimatePresence, motion } from "motion/react";
import { Backdrop, dialogMotion } from "./motion";
import { useState, useSyncExternalStore } from "react";
import { AlertTriangle, Trash2 } from "lucide-react";
import { ch, type Conversation, type Message } from "@/lib/relay";

export type DeleteChoice = { scope: "relay" | "everywhere"; forEveryone: boolean };
type What = "message" | "chat" | "clear";

type Prompt = {
  title: string;
  body: string;
  /** Button that deletes on the service; null when the channel can't (demo data). */
  everywhereLabel: string | null;
  /** Checkbox to also delete for the other side (Telegram), or null. */
  everyoneLabel: string | null;
  warning?: string | undefined;
  resolve: (choice: DeleteChoice | null) => void;
};

// One dialog for the whole app; any component can await askDelete(...).
let current: Prompt | null = null;
const listeners = new Set<() => void>();
const set = (p: Prompt | null) => {
  current = p;
  for (const l of listeners) l();
};

// Telegram peer ids are negative for groups and positive for people and bots.
const isTelegramGroup = (c: Conversation) => c.channel === "telegram" && c.externalId.startsWith("-");

function describe(what: What, convo: Conversation, message: Message | undefined, isDemo: boolean): Omit<Prompt, "resolve"> {
  const service = ch(convo.channel).name;
  if (isDemo) {
    return { title: what === "message" ? "Delete message?" : what === "clear" ? "Clear chat?" : "Delete chat?", body: "This is demo data, so it's only removed from Sangam.", everywhereLabel: null, everyoneLabel: null };
  }
  if (convo.channel === "gmail" || convo.channel === "mail") {
    const where = convo.channel === "gmail" ? "Gmail" : "your mail server";
    return {
      title: what === "message" ? "Delete this email?" : "Delete this email thread?",
      body: `${what === "message" ? "It" : "Every email in the thread"} moves to the Trash on ${where}${convo.channel === "gmail" ? ", where you can restore it for 30 days" : ""}.`,
      everywhereLabel: convo.channel === "gmail" ? "Move to Gmail Trash" : "Move to Trash",
      everyoneLabel: null,
    };
  }
  // Telegram
  const group = isTelegramGroup(convo);
  if (what === "message") {
    return {
      title: "Delete message?",
      body: `It's deleted in Telegram${group && message?.direction === "in" ? " for you" : ""}.`,
      everywhereLabel: `Delete in ${service}`,
      everyoneLabel: !group ? `Also delete for ${convo.name}` : message?.direction === "out" ? "Also delete for everyone in the group" : null,
    };
  }
  if (what === "clear") {
    return { title: "Clear chat history?", body: "All messages are cleared in Telegram; the chat itself stays.", everywhereLabel: "Clear in Telegram", everyoneLabel: group ? null : `Also clear for ${convo.name}` };
  }
  return group
    ? { title: "Leave this group?", body: `Deleting a Telegram group chat means leaving “${convo.name}”, like in the Telegram app.`, everywhereLabel: "Leave group", everyoneLabel: null, warning: "You'll need an invite to rejoin." }
    : { title: "Delete chat?", body: `The chat with ${convo.name} is deleted in Telegram.`, everywhereLabel: "Delete in Telegram", everyoneLabel: `Also delete for ${convo.name}` };
}

/** Same choice for several selected chats at once. Demo chats are always removed from Sangam only. */
export function askDeleteMany(convos: Conversation[], isDemo: (c: Conversation) => boolean) {
  const real = convos.filter((c) => !isDemo(c));
  const channels = new Set(real.map((c) => c.channel));
  const groups = real.filter(isTelegramGroup).length;
  const parts = [
    (channels.has("gmail") || channels.has("mail")) && "emails move to the Trash there",
    channels.has("telegram") && "Telegram chats are deleted in Telegram",
  ].filter(Boolean);
  const prompt: Omit<Prompt, "resolve"> = {
    title: `Delete ${convos.length} chat${convos.length === 1 ? "" : "s"}?`,
    body: real.length
      ? `Deleting them there too: ${parts.join("; ")}.${real.length < convos.length ? " Demo chats are only removed from Sangam." : ""}`
      : "These are demo chats, so they're only removed from Sangam.",
    everywhereLabel: real.length ? "Delete there too" : null,
    everyoneLabel: null,
    warning: groups ? `Includes ${groups} Telegram group${groups === 1 ? "" : "s"} — deleting there means leaving ${groups === 1 ? "it" : "them"}.` : undefined,
  };
  return new Promise<DeleteChoice | null>((resolve) => set({ ...prompt, resolve }));
}

/** Asks how to delete; resolves null when cancelled. */
export function askDelete(what: What, convo: Conversation, opts: { message?: Message; isDemo?: boolean } = {}) {
  return new Promise<DeleteChoice | null>((resolve) => set({ ...describe(what, convo, opts.message, !!opts.isDemo), resolve }));
}

export function DeleteConfirmHost() {
  const prompt = useSyncExternalStore((l) => (listeners.add(l), () => void listeners.delete(l)), () => current, () => null);
  const [everyone, setEveryone] = useState(false);
  const finish = (choice: DeleteChoice | null) => {
    prompt?.resolve(choice);
    setEveryone(false);
    set(null);
  };
  return (
    // Kept mounted inside AnimatePresence so the dialog can animate out after a choice.
    <AnimatePresence>
    {prompt && (
    <Backdrop key="confirm-delete" z="z-[60]" onClick={() => finish(null)} className="grid place-items-center p-4">
      <motion.div {...dialogMotion} role="alertdialog" aria-modal="true" onKeyDown={(e) => { if (e.key === "Escape") finish(null); }} className="w-full max-w-sm rounded-2xl border bg-popover p-5 shadow-soft" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-destructive/10 text-destructive"><Trash2 className="h-4 w-4" /></span>
          <div>
            <h3 className="font-semibold">{prompt.title}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{prompt.body}</p>
            {prompt.warning && <p className="mt-2 flex items-center gap-1.5 text-xs text-destructive"><AlertTriangle className="h-3.5 w-3.5" />{prompt.warning}</p>}
          </div>
        </div>
        {prompt.everyoneLabel && (
          <label className="mt-4 flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm">
            <input type="checkbox" checked={everyone} onChange={(e) => setEveryone(e.target.checked)} className="h-4 w-4 accent-[var(--destructive)]" />
            {prompt.everyoneLabel}
          </label>
        )}
        <div className="mt-5 flex flex-col gap-2">
          {prompt.everywhereLabel && (
            <button autoFocus onClick={() => finish({ scope: "everywhere", forEveryone: everyone })}
              className="rounded-lg bg-destructive px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90">
              {prompt.everywhereLabel}
            </button>
          )}
          <button onClick={() => finish({ scope: "relay", forEveryone: false })}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition ${prompt.everywhereLabel ? "border hover:bg-muted" : "bg-destructive font-semibold text-white hover:opacity-90"}`}>
            Remove from Sangam only
          </button>
          <button onClick={() => finish(null)} className="rounded-lg px-4 py-1.5 text-sm text-muted-foreground hover:bg-muted">Cancel</button>
        </div>
      </motion.div>
    </Backdrop>
    )}
    </AnimatePresence>
  );
}
