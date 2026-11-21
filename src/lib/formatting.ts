import DOMPurify from "dompurify";
import type { ChannelId } from "./relay";

/** What each channel can actually display. The editor only offers these, so nothing is lost on send. */
export type Caps = { bold: boolean; italic: boolean; underline: boolean; strike: boolean; code: boolean; codeBlock: boolean; quote: boolean; lists: boolean; link: boolean };

const ALL: Caps = { bold: true, italic: true, underline: true, strike: true, code: true, codeBlock: true, quote: true, lists: true, link: true };
export const CAPS: Record<ChannelId, Caps> = {
  gmail: ALL,
  mail: ALL,
  // Telegram has no list formatting (lists go as "•" text) and no underline-free restriction.
  telegram: { ...ALL, lists: false },
  // WhatsApp: *bold* _italic_ ~strike~ `code` ```block``` > quote, - lists. No underline; links are automatic.
  whatsapp: { ...ALL, underline: false, link: false },
  teams: ALL,
  sangam: ALL,
};

type Rules = {
  mark: (tag: "b" | "i" | "u" | "s" | "code", inner: string) => string;
  link: (href: string, inner: string) => string;
  pre: (text: string) => string;
  quote: (inner: string) => string;
  text: (text: string) => string;
};

const BLOCK = new Set(["P", "PRE", "BLOCKQUOTE", "UL", "OL", "LI", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "HR"]);
const MARK: Record<string, "b" | "i" | "u" | "s" | "code"> = { STRONG: "b", B: "b", EM: "i", I: "i", U: "u", S: "s", DEL: "s", STRIKE: "s", CODE: "code" };

/** Walks the editor's HTML and rebuilds it with a channel's rules; paragraphs become newlines. */
function convert(html: string, rules: Rules): string {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const inline = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return rules.text(node.textContent ?? "");
    if (!(node instanceof HTMLElement)) return "";
    const inner = () => [...node.childNodes].map(inline).join("");
    if (node.tagName === "BR") return "\n";
    if (node.tagName === "A") return rules.link(node.getAttribute("href") ?? "", inner());
    const mark = MARK[node.tagName];
    if (mark && !(mark === "code" && node.parentElement?.tagName === "PRE")) {
      const content = inner();
      // Markers must hug the text ("*bold* " not "*bold *"), so keep edge spaces outside.
      const [, lead, core, trail] = content.match(/^(\s*)([\s\S]*?)(\s*)$/) ?? ["", "", content, ""];
      return core ? `${lead}${rules.mark(mark, core!)}${trail}` : content;
    }
    return block(node);
  };
  const block = (el: HTMLElement): string => {
    switch (el.tagName) {
      case "PRE":
        return rules.pre(el.textContent ?? "");
      case "BLOCKQUOTE":
        return rules.quote(children(el));
      case "UL":
      case "OL":
        return [...el.children].map((li, i) => `${el.tagName === "OL" ? `${i + 1}.` : "•"} ${children(li as HTMLElement)}`).join("\n");
      default:
        return children(el);
    }
  };
  // Block children are separated by newlines; inline content is concatenated.
  const children = (el: HTMLElement): string => {
    const parts: string[] = [];
    let line = "";
    for (const child of el.childNodes) {
      if (child instanceof HTMLElement && BLOCK.has(child.tagName)) {
        if (line) parts.push(line);
        line = "";
        parts.push(block(child));
      } else line += inline(child);
    }
    if (line) parts.push(line);
    return parts.join("\n");
  };
  return children(doc.body.firstElementChild as HTMLElement).replace(/\n{3,}/g, "\n\n").trim();
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s: string) => escapeHtml(s).replace(/"/g, "&quot;");
const safeHref = (href: string) => (/^(https?:|mailto:|tel:)/i.test(href) ? href : "");

/** Plain text: for previews, search, and channels without formatting. */
export const toPlainText = (html: string) =>
  convert(html, {
    mark: (_t, inner) => inner,
    link: (href, inner) => (href && inner !== href ? `${inner} (${href})` : inner),
    pre: (text) => text,
    quote: (inner) => inner.split("\n").map((l) => `> ${l}`).join("\n"),
    text: (t) => t,
  });

/** WhatsApp's own markers: *bold* _italic_ ~strike~ `code` ```block``` and "> " quotes. */
export const toWhatsApp = (html: string) =>
  convert(html, {
    mark: (tag, inner) => (tag === "b" ? `*${inner}*` : tag === "i" ? `_${inner}_` : tag === "s" ? `~${inner}~` : tag === "code" ? `\`${inner}\`` : inner),
    link: (href, inner) => (href && inner !== href ? `${inner} (${href})` : inner),
    pre: (text) => `\`\`\`${text}\`\`\``,
    quote: (inner) => inner.split("\n").map((l) => `> ${l}`).join("\n"),
    text: (t) => t,
  });

/** Telegram's HTML subset (b, i, u, s, code, pre, a, blockquote); everything else is escaped text. */
export const toTelegramHtml = (html: string) =>
  convert(html, {
    mark: (tag, inner) => `<${tag}>${inner}</${tag}>`,
    link: (href, inner) => (safeHref(href) ? `<a href="${escapeAttr(safeHref(href))}">${inner}</a>` : inner),
    pre: (text) => `<pre>${escapeHtml(text)}</pre>`,
    quote: (inner) => `<blockquote>${inner}</blockquote>`,
    text: escapeHtml,
  });

// Also a few tags people type by hand (headings, <small>, <hr>…) when writing HTML directly.
const EMAIL_TAGS = ["p", "br", "strong", "b", "em", "i", "u", "s", "del", "code", "pre", "a", "ul", "ol", "li", "blockquote", "h1", "h2", "h3", "h4", "small", "sub", "sup", "mark", "hr"];

/** Email HTML: the editor's markup, limited to formatting tags and safe links. */
export const toEmailHtml = (html: string) =>
  DOMPurify.sanitize(html, { ALLOWED_TAGS: EMAIL_TAGS, ALLOWED_ATTR: ["href"], ALLOWED_URI_REGEXP: /^(https?:|mailto:|tel:)/i });

/** True when the editor content has any formatting at all (plain messages stay plain). */
export const hasFormatting = (html: string) => /<(strong|b|em|i|u|s|del|code|pre|a|blockquote|ul|ol|h[1-4]|small|sub|sup|mark|hr)\b/i.test(html);

/**
 * The editor content with the signature added after a blank line. The signature is plain text,
 * or simple HTML when it has real tags (e.g. "<small>Sent from Sangam</small>").
 */
export function withSignature(editorHtml: string, signature: string) {
  const sig = signature.trim();
  if (!sig) return editorHtml;
  if (TYPED_HTML.test(sig)) return `${editorHtml}<p><br></p>${HAS_BLOCKS.test(sig) ? sig : `<p>${sig.replace(/\n/g, "<br>")}</p>`}`;
  return `${editorHtml}<p><br></p><p>${escapeHtml(sig).replace(/\n/g, "<br>")}</p>`;
}

// A real tag pair (<b>…</b>) or a <br>/<hr>: "a < b > c" or "<3" stays text.
const TYPED_HTML = /<([a-z][a-z0-9]*)\b[^<>]*>[\s\S]*<\/\1\s*>|<(br|hr)\s*\/?>/i;
const HAS_BLOCKS = /<(p|div|br|ul|ol|li|h[1-6]|pre|blockquote|table|hr)\b/i;

/**
 * HTML typed (or pasted) into the editor as text: treated as the message's markup, so typing
 * `<b>Hi</b>` sends bold. Lines become <br> unless the markup has its own blocks. Null if it's just text.
 */
export function typedHtml(editorHtml: string): string | null {
  const text = toPlainText(editorHtml);
  if (!TYPED_HTML.test(text)) return null;
  return HAS_BLOCKS.test(text) ? text : text.replace(/\n/g, "<br>");
}

/** Whether a message you wrote gets the signature: it's set up for this app, and it isn't a bot command or files only. */
export function signatureApplies(channel: ChannelId, text: string, settings: { signature: string; signatureChannels: ChannelId[] } | undefined) {
  if (!settings?.signature.trim() || !settings.signatureChannels.includes(channel)) return false;
  const t = text.trim();
  return !!t && !(channel === "telegram" && t.startsWith("/"));
}

/** What to send for a channel: `text` always, `html` only where the service renders it. */
export function outgoingFor(channel: ChannelId, content: string): { text: string; html?: string } {
  const editorHtml = typedHtml(content) ?? content;
  const formatted = hasFormatting(editorHtml) || editorHtml !== content;
  if (channel === "whatsapp") return { text: formatted ? toWhatsApp(editorHtml) : toPlainText(editorHtml) };
  const text = toPlainText(editorHtml);
  if (!formatted) return { text };
  if (channel === "telegram") return { text, html: toTelegramHtml(editorHtml) };
  return { text, html: toEmailHtml(editorHtml) };
}

/** Sent formatted messages shown in a chat bubble: same safe subset as email. */
export const bubbleHtml = (html: string) => toEmailHtml(html);

/** True for HTML written in our editor (or Telegram's subset), not a full email layout synced from a mailbox. */
export const isComposedHtml = (html: string) => !/<(html|head|body|style|table|div|span|font|img)\b/i.test(html);

export type WaSegment = { text: string; b?: boolean; i?: boolean; s?: boolean; code?: boolean; pre?: boolean };

// ```block```, `code`, and *bold* _italic_ ~strike~ that hug their words, like WhatsApp renders them.
const WA_TOKEN = /```([\s\S]+?)```|`([^`\n]+)`|(?<![\w*_~])([*_~])(?!\s)([^\n]*?[^\s])\3(?![\w*_~])/g;

/** Splits WhatsApp-formatted text into styled segments (nesting like *_both_* is supported). */
export function parseWhatsApp(text: string, style: Omit<WaSegment, "text"> = {}): WaSegment[] {
  const out: WaSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(WA_TOKEN)) {
    const index = m.index ?? 0;
    if (index > last) out.push({ ...style, text: text.slice(last, index) });
    if (m[1] !== undefined) out.push({ ...style, text: m[1], pre: true });
    else if (m[2] !== undefined) out.push({ ...style, text: m[2], code: true });
    else {
      const flag = m[3] === "*" ? "b" : m[3] === "_" ? "i" : "s";
      out.push(...parseWhatsApp(m[4]!, { ...style, [flag]: true }));
    }
    last = index + m[0].length;
  }
  if (last < text.length) out.push({ ...style, text: text.slice(last) });
  return out;
}
