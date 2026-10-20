import { ExternalLink, Slash } from "lucide-react";
import type { BotCommand, Message } from "@/lib/relay";

// URLs, and /commands that start a word (optionally /command@SomeBot, as used in groups).
const TOKEN = /(https?:\/\/[^\s<>"']*[^\s<>"'.,;:!?)\]])|((?:^|(?<=\s))\/[a-zA-Z0-9_]{1,32}(?:@[a-zA-Z0-9_]{3,32})?(?![\w/]))/g;

/** Message text with clickable links, and (in bot chats) tappable /commands. */
export function RichText({ text, onCommand }: { text: string; onCommand?: ((command: string) => void) | undefined }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    const index = match.index ?? 0;
    if (index > last) parts.push(text.slice(last, index));
    const [token, url, command] = match;
    if (url) {
      parts.push(
        <a key={index} href={url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 opacity-90 hover:opacity-100">
          {url}
        </a>,
      );
    } else if (command && onCommand) {
      parts.push(
        <button key={index} onClick={() => onCommand(command)} title={`Send ${command}`} className="font-medium underline decoration-dotted underline-offset-2 hover:decoration-solid">
          {command}
        </button>,
      );
    } else {
      parts.push(token);
    }
    last = index + token.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <p className="whitespace-pre-wrap break-words leading-relaxed">{parts}</p>;
}

/** A bot's inline buttons under its message, laid out in the bot's rows. */
export function MessageButtons({ message, onPress, pending }: { message: Message; onPress: (row: number, col: number) => void; pending: boolean }) {
  const rows = message.extra?.buttons;
  if (!rows?.length) return null;
  const base = "flex min-w-0 flex-1 items-center justify-center gap-1 truncate rounded-lg border bg-card px-3 py-1.5 text-xs font-medium shadow-soft transition";
  return (
    <div className="mt-1.5 space-y-1.5">
      {rows.map((row, r) => (
        <div key={r} className="flex gap-1.5">
          {row.map((b, c) =>
            b.kind === "url" ? (
              <a key={c} href={b.url} target="_blank" rel="noopener noreferrer" className={`${base} hover:bg-muted`} title={b.url}>
                <span className="truncate">{b.text}</span> <ExternalLink className="h-3 w-3 shrink-0 opacity-60" />
              </a>
            ) : (
              <button key={c} disabled={b.kind === "unsupported" || pending} onClick={() => onPress(r, c)}
                title={b.kind === "unsupported" ? "This kind of button only works in the Telegram app" : undefined}
                className={`${base} hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50`}>
                <span className="truncate">{b.text}</span>
              </button>
            ),
          )}
        </div>
      ))}
    </div>
  );
}

/** The custom keyboard a bot shows in place of the normal one; tapping a key sends its text. */
export function BotKeyboard({ rows, onSend }: { rows: string[][]; onSend: (text: string) => void }) {
  return (
    <div className="scrollbar-thin max-h-40 space-y-1.5 overflow-y-auto pb-2">
      {rows.map((row, r) => (
        <div key={r} className="flex gap-1.5">
          {row.map((key, c) => (
            <button key={c} onClick={() => onSend(key)} className="min-w-0 flex-1 truncate rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground hover:opacity-80">
              {key}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

/** "/" suggestions: the bot's commands matching what's typed so far. */
export function CommandList({ commands, filter, onPick }: { commands: BotCommand[]; filter: string; onPick: (command: string) => void }) {
  const q = filter.replace(/^\//, "").toLowerCase();
  const matches = commands.filter((c) => c.command.toLowerCase().startsWith(q)).slice(0, 8);
  if (!matches.length) return null;
  return (
    <div className="mb-2 overflow-hidden rounded-xl border bg-popover shadow-soft">
      {matches.map((c) => (
        <button key={c.command} onClick={() => onPick(`/${c.command}`)} className="flex w-full items-baseline gap-2 px-3 py-2 text-left text-sm transition hover:bg-muted">
          <span className="flex shrink-0 items-center font-medium text-primary"><Slash className="h-3 w-3" />{c.command}</span>
          <span className="truncate text-xs text-muted-foreground">{c.description}</span>
        </button>
      ))}
    </div>
  );
}
