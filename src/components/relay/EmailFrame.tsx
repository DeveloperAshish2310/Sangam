import { useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";

let hooked = false;
function sanitizer() {
  if (!hooked) {
    // Every link opens in a new tab, never inside the frame, and without a referrer.
    DOMPurify.addHook("afterSanitizeAttributes", (node) => {
      if (node.tagName === "A") {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer");
      }
    });
    hooked = true;
  }
  return DOMPurify;
}

export const hasRemoteImages = (html: string) => /<img[^>]+src\s*=\s*["']?https?:|url\(\s*["']?https?:/i.test(html);

/**
 * A plain email (text with basic formatting, no layout, colours or images of its own) can be shown
 * in Sangam's colours, so it reads like a message instead of a white page. Designed emails keep theirs.
 */
export function isSimpleEmail(html: string) {
  if (/<(style|table|img|font|center|link|svg|video)\b|\sbgcolor\s*=|\scolor\s*=|\sbackground\s*=/i.test(html)) return false;
  // Inline styles may set fonts and spacing, but not colours or backgrounds.
  return ![...html.matchAll(/\sstyle\s*=\s*("[^"]*"|'[^']*')/gi)].some((m) => /(^|[;\s"'])(color|background(-color|-image)?)\s*:/i.test(m[1]!));
}

/** Colours for a simple email, taken from the surrounding card. */
export type FrameTheme = { color: string; background: string; link: string; dark: boolean };

export function buildDocument(html: string, allowImages: boolean, theme?: FrameTheme) {
  const clean = sanitizer()
    .sanitize(html, { WHOLE_DOCUMENT: true, FORBID_TAGS: ["form", "input", "button", "textarea", "select"] })
    // Emails are shown in their light design, like Gmail does. Many ship half-finished dark-mode
    // rules (dark card backgrounds, unchanged dark text) that turn unreadable, so an invalid
    // media value makes those blocks never match.
    .replace(/prefers-color-scheme\s*:\s*dark/gi, "prefers-color-scheme: relay-light-only");
  const remote = allowImages ? " https: http:" : "";
  // The CSP is the real image/tracking-pixel gate: without "Load images", nothing leaves this PC.
  const head = [
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'${remote}; img-src data: cid:${remote}; font-src data:${remote}">`,
    `<base target="_blank">`,
    `<meta name="color-scheme" content="${theme?.dark ? "dark only" : "light only"}">`,
    `<style>
      :root { color-scheme: ${theme?.dark ? "dark" : "light"} only; }
      html { margin: 0; padding: 0; }
      body { margin: 0; padding: 14px 16px; background: #fff; color: #111; font: 14px/1.55 system-ui, sans-serif; overflow-wrap: anywhere; }
      ${theme ? `body { background: ${theme.background} !important; color: ${theme.color} !important; font-family: system-ui, sans-serif !important; }
      a { color: ${theme.link}; }
      p { margin: 0 0 0.6em; } p:last-child { margin-bottom: 0; }
      small { opacity: 0.75; }
      blockquote { margin: 0.4em 0; padding-left: 0.75em; border-left: 3px solid currentColor; opacity: 0.8; }
      code, pre { font-family: ui-monospace, monospace; font-size: 0.9em; background: rgba(127,127,127,0.15); border-radius: 4px; }
      code { padding: 0.1em 0.3em; } pre { padding: 0.6em 0.8em; overflow-x: auto; }` : ""}
      img { max-width: 100%; height: auto; }
      table { max-width: 100% !important; }
      /* Quoted history from earlier messages in the thread is already shown above. */
      .gmail_quote, blockquote[type="cite"], #divRplyFwdMsg, #divRplyFwdMsg ~ * { display: none !important; }
    </style>`,
  ].join("");
  // A doctype keeps the frame out of quirks mode, where the body always reports the frame's full height.
  const full = clean.includes("<head>") ? clean.replace("<head>", `<head>${head}`) : `<html><head>${head}</head><body>${clean}</body></html>`;
  return /^\s*<!doctype/i.test(full) ? full : `<!doctype html>${full}`;
}

/**
 * Renders an email's HTML in a sandboxed iframe: no scripts, forms, or plugins, and links
 * escape to a new tab. allow-same-origin is only there so Sangam can measure the content
 * height — it's safe because scripts can never run inside (no allow-scripts).
 */
export function EmailFrame({ html, allowImages }: { html: string; allowImages: boolean }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(60);
  const [theme, setTheme] = useState<FrameTheme | undefined>();
  const simple = useMemo(() => isSimpleEmail(html), [html]);

  // Simple emails take the card's colours (and follow light/dark mode when it changes).
  useEffect(() => {
    const frame = ref.current;
    if (!simple || !frame?.parentElement) return setTheme(undefined);
    const read = () => {
      const card = getComputedStyle(frame.parentElement!);
      const primary = getComputedStyle(document.documentElement).getPropertyValue("--primary").trim();
      const dark = document.documentElement.classList.contains("dark");
      setTheme({ color: card.color, background: card.backgroundColor, link: dark ? "#8ab4f8" : primary || "#1a73e8", dark });
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
    return () => observer.disconnect();
  }, [simple]);

  const doc = useMemo(() => (typeof window === "undefined" || (simple && !theme) ? "" : buildDocument(html, allowImages, theme)), [html, allowImages, simple, theme]);

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let observer: ResizeObserver | undefined;
    // The body's own height (not the page's, which is never smaller than the frame itself).
    const measure = () => {
      const body = frame.contentDocument?.body;
      if (body) setHeight(Math.min(Math.ceil(body.getBoundingClientRect().height), 4000));
    };
    const onLoad = () => {
      measure();
      const body = frame.contentDocument?.body;
      if (body) {
        observer = new ResizeObserver(measure);
        observer.observe(body);
      }
    };
    frame.addEventListener("load", onLoad);
    return () => {
      frame.removeEventListener("load", onLoad);
      observer?.disconnect();
    };
  }, [doc]);

  return (
    <iframe
      ref={ref}
      title="Email content"
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      srcDoc={doc}
      // Inside an iframe, prefers-color-scheme follows this element's color-scheme, not the OS.
      style={{ height, colorScheme: theme?.dark ? "dark" : "light" }}
      className={`block w-full border-0 ${theme ? "" : "bg-white"}`}
    />
  );
}
