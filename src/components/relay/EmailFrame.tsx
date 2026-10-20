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

export function buildDocument(html: string, allowImages: boolean) {
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
    `<meta name="color-scheme" content="light only">`,
    `<style>
      :root { color-scheme: light only; }
      html, body { margin: 0; padding: 12px; background: #fff; color: #111; font: 14px/1.5 system-ui, sans-serif; overflow-wrap: anywhere; }
      img { max-width: 100%; height: auto; }
      table { max-width: 100% !important; }
      /* Quoted history from earlier messages in the thread is already shown above. */
      .gmail_quote, blockquote[type="cite"], #divRplyFwdMsg, #divRplyFwdMsg ~ * { display: none !important; }
    </style>`,
  ].join("");
  return clean.includes("<head>") ? clean.replace("<head>", `<head>${head}`) : `<html><head>${head}</head><body>${clean}</body></html>`;
}

/**
 * Renders an email's HTML in a sandboxed iframe: no scripts, forms, or plugins, and links
 * escape to a new tab. allow-same-origin is only there so Sangam can measure the content
 * height — it's safe because scripts can never run inside (no allow-scripts).
 */
export function EmailFrame({ html, allowImages }: { html: string; allowImages: boolean }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(160);
  const doc = useMemo(() => (typeof window === "undefined" ? "" : buildDocument(html, allowImages)), [html, allowImages]);

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let observer: ResizeObserver | undefined;
    const measure = () => {
      const root = frame.contentDocument?.documentElement;
      if (root) setHeight(Math.min(root.scrollHeight, 4000));
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
      style={{ height, colorScheme: "light" }}
      className="block w-full border-0 bg-white"
    />
  );
}
