import { randomUUID } from "node:crypto";
import type { gmail_v1 } from "@googleapis/gmail";

type Part = gmail_v1.Schema$MessagePart;

const MAX_TEXT = 20_000;

export const header = (msg: gmail_v1.Schema$Message, name: string) =>
  msg.payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";

const decode = (data: string | null | undefined) => (data ? Buffer.from(data, "base64url").toString("utf8") : "");

function findPart(part: Part | undefined, mime: string): Part | undefined {
  if (!part) return undefined;
  // Attachments carry a filename; never treat one as the message body.
  if (part.mimeType === mime && part.body?.data && !part.filename) return part;
  for (const child of part.parts ?? []) {
    const found = findPart(child, mime);
    if (found) return found;
  }
  return undefined;
}

// Plain-text parts that only say "view the HTML version" carry no real content.
const STUB_TEXT = /enable html|html[- ]?(version|email|format|enabled|capable|compatible)|requires? (an )?html|(can'?t|cannot|unable to|does ?n[o']t) (display|show|render|view) html|view (this|it) (email |message )?(online|in (a|your) (web )?browser)|does ?n[o']t support html|can'?t (see|view|read) this (email|message)/i;

/** The readable text of a message: the plain part, unless it's only a stub pointing at the HTML part. */
export function bestText(plain: string, html: string | null) {
  const fromHtml = html ? dropViewOnlineHeader(htmlToText(html)) : "";
  if (!plain.trim()) return fromHtml;
  // A stub sentence near the top means the plain part is a placeholder (often padded with a long
  // tracking link); the HTML part is the same email, so nothing real is lost by using it.
  if (fromHtml && STUB_TEXT.test(plain.slice(0, 300))) return fromHtml;
  // Some senders put HTML markup into the plain-text part; strip it rather than show tags.
  if (/<(span|div|p|br|table|td|tr|a|font|img|b|strong)\b[^>]*>/i.test(plain)) return htmlToText(plain);
  return plain;
}

export function htmlToText(html: string) {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, "")
    // Line breaks and indentation in HTML source are just spaces, as a browser treats them.
    .replace(/\s+/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// "Having trouble viewing this e-mail? View it in your browser" headers before the real content.
const VIEW_ONLINE_LINE = /trouble viewing|view (this|it|the)?\s*(e-?mail|newsletter|message)?\s*(online|in (a |your )?(web )?browser)|^view in browser/i;

/** Text extracted by an older version (source indentation kept, "trouble viewing" header first). */
export const isStaleHtmlText = (text: string) => /\n[ \t]{4,}\S/.test(text) || VIEW_ONLINE_LINE.test(text.split("\n")[0] ?? "");

const dropViewOnlineHeader = (text: string) => {
  const lines = text.split("\n");
  let start = 0;
  while (start < Math.min(3, lines.length) && (VIEW_ONLINE_LINE.test(lines[start]!) || !lines[start]!.trim())) start++;
  return lines.slice(start).join("\n").trim() || text;
};

/** Drops the quoted history most mail clients append below a reply. */
export function stripQuoted(text: string) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const cut = lines.findIndex(
    (line, i) =>
      /^On .+wrote:\s*$/.test(line) ||
      // Gmail sometimes wraps "On … <addr>" and "wrote:" onto two lines.
      (/^On .+/.test(line) && /^.*wrote:\s*$/.test(lines[i + 1] ?? "") && line.length > 20) ||
      /^-{2,}\s*Original Message\s*-{2,}/i.test(line) ||
      /^_{10,}$/.test(line),
  );
  const kept = (cut > 0 ? lines.slice(0, cut) : lines).filter((l, i, all) => !(l.startsWith(">") && all.slice(i).every((x) => x.startsWith(">") || !x.trim())));
  return kept.join("\n").trim();
}

export function messageBody(msg: gmail_v1.Schema$Message) {
  const html = decode(findPart(msg.payload, "text/html")?.body?.data);
  const plain = decode(findPart(msg.payload, "text/plain")?.body?.data);
  const full = bestText(plain, html || null) || msg.snippet || "";
  const text = (stripQuoted(full) || full).slice(0, MAX_TEXT);
  return { text, html: html || null };
}

/** "Priya Sharma <priya@x.com>" → { name: "Priya Sharma", email: "priya@x.com" } */
export function parseAddress(value: string) {
  const match = value.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (match) return { name: match[1]!.trim() || match[2]!, email: match[2]!.trim().toLowerCase() };
  const email = value.trim().toLowerCase();
  return { name: email, email };
}

const noNewlines = (value: string) => value.replace(/[\r\n]+/g, " ").trim();

const encodeHeader = (value: string) =>
  // RFC 2047 encoding for non-ASCII subjects and names.
  /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;

/** Builds a raw RFC 2822 reply (see buildEmail). */
export function buildReply(opts: { from: string; to: string; subject: string; inReplyTo: string; references: string; text: string; attachments?: EmailAttachment[] }) {
  return buildEmail({ ...opts, subject: /^re:/i.test(opts.subject) ? opts.subject : `Re: ${opts.subject}` });
}

export type EmailAttachment = { name: string; mime: string; data: Buffer };

const CRLF = "\r\n";
const base64Lines = (data: Buffer) => data.toString("base64").replace(/.{76}/g, `$&${CRLF}`);
// Filenames go inside quotes in headers: no quotes/backslashes/newlines, non-ASCII RFC 2047-encoded.
const headerFilename = (name: string) => encodeHeader(noNewlines(name).replace(/["\\]/g, "_")) || "file";
const safeMime = (mime: string) => (/^[\w.+-]+\/[\w.+-]+$/.test(mime) ? mime : "application/octet-stream");

/** Builds a raw RFC 2822 email (new or reply), with optional file attachments. */
export function buildEmail(opts: { from: string; to: string; subject: string; inReplyTo?: string; references?: string; text: string; attachments?: EmailAttachment[] }) {
  const head = [
    `From: ${noNewlines(opts.from)}`,
    `To: ${noNewlines(opts.to)}`,
    `Subject: ${encodeHeader(noNewlines(opts.subject))}`,
    opts.inReplyTo && `In-Reply-To: ${noNewlines(opts.inReplyTo)}`,
    (opts.references || opts.inReplyTo) && `References: ${noNewlines([opts.references, opts.inReplyTo].filter(Boolean).join(" "))}`,
    "MIME-Version: 1.0",
  ].filter(Boolean) as string[];
  const textPart = ["Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", base64Lines(Buffer.from(opts.text, "utf8"))].join(CRLF);
  if (!opts.attachments?.length) return Buffer.from([...head, textPart].join(CRLF), "utf8");

  // multipart/mixed: the text first (Gmail numbers it part "0"), then each file ("1", "2", …).
  const boundary = `sangam-${randomUUID()}`;
  const parts = [
    textPart,
    ...opts.attachments.map((a) =>
      [
        `Content-Type: ${safeMime(a.mime)}; name="${headerFilename(a.name)}"`,
        `Content-Disposition: attachment; filename="${headerFilename(a.name)}"`,
        "Content-Transfer-Encoding: base64",
        "",
        base64Lines(a.data),
      ].join(CRLF),
    ),
  ];
  const body = parts.map((p) => `--${boundary}${CRLF}${p}`).join(CRLF) + `${CRLF}--${boundary}--${CRLF}`;
  return Buffer.from([...head, `Content-Type: multipart/mixed; boundary="${boundary}"`, "", body].join(CRLF), "utf8");
}

const partHeader = (part: Part, name: string) => part.headers?.find((h) => h.name?.toLowerCase() === name)?.value ?? "";

/** Real attachments of a Gmail message — not the body parts, and not images embedded in the HTML. */
export function gmailAttachments(msg: gmail_v1.Schema$Message) {
  const found: { key: string; name: string; mime: string; size: number | null; data?: Buffer }[] = [];
  const walk = (part: Part | undefined) => {
    if (!part) return;
    const embedded = !!partHeader(part, "content-id") && /^inline/i.test(partHeader(part, "content-disposition"));
    if (part.filename && (part.body?.attachmentId || part.body?.data) && !embedded) {
      found.push({
        key: part.partId ?? part.filename,
        name: part.filename,
        mime: part.mimeType ?? "application/octet-stream",
        size: part.body?.size ?? null,
        ...(part.body?.data && { data: Buffer.from(part.body.data, "base64url") }),
      });
    }
    for (const child of part.parts ?? []) walk(child);
  };
  walk(msg.payload);
  return found;
}

export function findPartById(part: Part | undefined, partId: string): Part | undefined {
  if (!part) return undefined;
  if (part.partId === partId) return part;
  for (const child of part.parts ?? []) {
    const hit = findPartById(child, partId);
    if (hit) return hit;
  }
  return undefined;
}
