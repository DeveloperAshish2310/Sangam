import { describe, expect, it } from "vitest";
import { hasFormatting, outgoingFor, toPlainText, toTelegramHtml, toWhatsApp } from "@/lib/formatting";

const editor = "<p>Hi <strong>Priya</strong>, the <em>final</em> numbers are <s>late</s> ready.</p><p>Run <code>npm test</code> first:</p><pre><code>npm install\nnpm test</code></pre><blockquote><p>Ship it</p></blockquote><ul><li><p>Invoices</p></li><li><p>Report</p></li></ul><p>See <a href=\"https://example.com\">the doc</a></p>";

describe("rich text conversion", () => {
  it("WhatsApp gets its own markers", () => {
    const out = toWhatsApp(editor);
    expect(out).toContain("Hi *Priya*, the _final_ numbers are ~late~ ready.");
    expect(out).toContain("Run `npm test` first:");
    expect(out).toContain("```npm install\nnpm test```");
    expect(out).toContain("> Ship it");
    expect(out).toContain("• Invoices\n• Report");
    expect(out).toContain("See the doc (https://example.com)");
  });

  it("markers hug the words, keeping spaces outside", () => {
    expect(toWhatsApp("<p>a<strong> bold </strong>b</p>")).toBe("a *bold* b");
  });

  it("Telegram gets its HTML subset with text escaped", () => {
    const out = toTelegramHtml("<p>1 &lt; 2 &amp; <strong>bold</strong> <u>under</u></p><p><a href=\"https://x.io\">link</a> <a href=\"javascript:alert(1)\">bad</a></p>");
    expect(out).toBe('1 &lt; 2 &amp; <b>bold</b> <u>under</u>\n<a href="https://x.io">link</a> bad');
  });

  it("plain text keeps the words and structure only", () => {
    expect(toPlainText(editor)).toContain("Hi Priya, the final numbers are late ready.");
    expect(toPlainText(editor)).not.toContain("<");
  });

  it("plain messages stay plain; formatted ones carry HTML only where the channel renders it", () => {
    expect(hasFormatting("<p>just text</p>")).toBe(false);
    expect(outgoingFor("telegram", "<p>just text</p>")).toEqual({ text: "just text" });
    expect(outgoingFor("whatsapp", "<p><strong>hi</strong></p>")).toEqual({ text: "*hi*" });
    expect(outgoingFor("telegram", "<p><strong>hi</strong></p>")).toEqual({ text: "hi", html: "<b>hi</b>" });
    const email = outgoingFor("gmail", "<p><strong>hi</strong><img src=x onerror=alert(1)></p>");
    expect(email.text).toBe("hi");
    expect(email.html).toBe("<p><strong>hi</strong></p>");
  });
});

describe("WhatsApp markers on screen", () => {
  it("turns markers into styled segments and leaves stray symbols alone", async () => {
    const { parseWhatsApp } = await import("@/lib/formatting");
    expect(parseWhatsApp("hi *there* and _you_")).toEqual([{ text: "hi " }, { text: "there", b: true }, { text: " and " }, { text: "you", i: true }]);
    expect(parseWhatsApp("*_both_*")).toEqual([{ text: "both", b: true, i: true }]);
    expect(parseWhatsApp("2 * 3 * 4 and snake_case_name")).toEqual([{ text: "2 * 3 * 4 and snake_case_name" }]);
    expect(parseWhatsApp("run `npm i` then ```a\nb```")).toEqual([{ text: "run " }, { text: "npm i", code: true }, { text: " then " }, { text: "a\nb", pre: true }]);
  });

  it("round-trips: what the editor sends to WhatsApp shows formatted again", async () => {
    const { parseWhatsApp } = await import("@/lib/formatting");
    expect(parseWhatsApp(toWhatsApp("<p>a <strong>bold</strong> <s>gone</s></p>"))).toEqual([{ text: "a " }, { text: "bold", b: true }, { text: " " }, { text: "gone", s: true }]);
  });
});

describe("HTML typed into the editor", () => {
  // Exactly what was typed in the New message box (the editor stored it as text, inside inline code).
  const typed = "<p><code>&lt;b&gt;This is Bold Text from Ashish.&lt;/b&gt;</code></p><p></p><p><code>&lt;small&gt;Sent from Sangam&lt;/small&gt;</code></p>";

  it("is sent as real HTML to email", () => {
    expect(outgoingFor("gmail", typed)).toEqual({
      text: "This is Bold Text from Ashish.\n\nSent from Sangam",
      html: "<b>This is Bold Text from Ashish.</b><br><br><small>Sent from Sangam</small>",
    });
  });

  it("becomes formatting on Telegram and WhatsApp", () => {
    expect(outgoingFor("telegram", typed).html).toBe("<b>This is Bold Text from Ashish.</b>\n\nSent from Sangam");
    expect(outgoingFor("whatsapp", typed).text).toBe("*This is Bold Text from Ashish.*\n\nSent from Sangam");
  });

  it("leaves ordinary text with < and > alone, and strips dangerous markup", () => {
    expect(outgoingFor("gmail", "<p>if a &lt; b and b &gt; c &lt;3</p>")).toEqual({ text: "if a < b and b > c <3" });
    expect(outgoingFor("gmail", "<p>&lt;b onclick=x&gt;hi&lt;/b&gt;&lt;script&gt;alert(1)&lt;/script&gt;</p>").html).toBe("<b>hi</b>");
  });
});

describe("signature", () => {
  it("is added after a blank line on every channel, HTML signatures rendered", async () => {
    const { withSignature } = await import("@/lib/formatting");
    const signed = withSignature("<p>Hi <strong>there</strong></p>", "— Ashish\n<small>Sent from Sangam</small>");
    expect(outgoingFor("gmail", signed)).toEqual({
      text: "Hi there\n\n— Ashish\nSent from Sangam",
      html: "<p>Hi <strong>there</strong></p><p><br></p><p>— Ashish<br><small>Sent from Sangam</small></p>",
    });
    expect(outgoingFor("whatsapp", signed).text).toBe("Hi *there*\n\n— Ashish\nSent from Sangam");
    expect(outgoingFor("telegram", signed).text).toBe("Hi there\n\n— Ashish\nSent from Sangam");
  });

  it("plain-text signatures are escaped, and plain messages stay plain", async () => {
    const { withSignature } = await import("@/lib/formatting");
    expect(outgoingFor("gmail", withSignature("<p>ok</p>", "Ashish <CEO>"))).toEqual({ text: "ok\n\nAshish <CEO>" });
    expect(withSignature("<p>ok</p>", "  ")).toBe("<p>ok</p>");
  });

  it("is skipped for other apps, bot commands and empty messages", async () => {
    const { signatureApplies } = await import("@/lib/formatting");
    const s = { signature: "— Ashish", signatureChannels: ["gmail", "telegram"] as const };
    const settings = { ...s, signatureChannels: [...s.signatureChannels] };
    expect(signatureApplies("gmail", "Hello", settings)).toBe(true);
    expect(signatureApplies("whatsapp", "Hello", settings)).toBe(false);
    expect(signatureApplies("telegram", "/start", settings)).toBe(false);
    expect(signatureApplies("gmail", "  ", settings)).toBe(false);
    expect(signatureApplies("gmail", "Hello", { signature: "", signatureChannels: ["gmail"] })).toBe(false);
  });
});
