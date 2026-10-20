import { describe, expect, it } from "vitest";
import { buildDocument, hasRemoteImages } from "@/components/relay/EmailFrame";
import { bestText } from "../../backend/connectors/mime";

const hostile = `<!doctype html><html><head><style>.brand{color:red}</style><script>alert(1)</script></head>
<body><p class="brand">Your order shipped</p>
<img src="https://tracker.example/pixel.gif" onerror="alert(2)">
<a href="javascript:alert(3)">click</a> <a href="https://shop.example/order">View order</a>
<form action="https://phish.example"><input name="password"><button>Log in</button></form>
<iframe src="https://evil.example"></iframe></body></html>`;

describe("EmailFrame document", () => {
  const doc = buildDocument(hostile, false);

  it("keeps the email's own styling and content", () => {
    expect(doc).toContain(".brand{color:red}");
    expect(doc).toContain("Your order shipped");
  });

  it("strips scripts, event handlers, javascript: links, forms and nested frames", () => {
    expect(doc).not.toMatch(/<script/i);
    expect(doc).not.toMatch(/onerror/i);
    expect(doc).not.toMatch(/javascript:/i);
    expect(doc).not.toMatch(/<form|<input|<button/i);
    expect(doc).not.toMatch(/<iframe/i);
  });

  it("opens links in a new tab without a referrer", () => {
    expect(doc).toMatch(/<a href="https:\/\/shop\.example\/order" target="_blank" rel="noopener noreferrer">/);
  });

  it("blocks remote images until allowed", () => {
    expect(doc).toMatch(/img-src data: cid:;/);
    expect(doc).not.toMatch(/img-src[^;"]*https:/);
    expect(buildDocument(hostile, true)).toMatch(/img-src data: cid: https: http:/);
  });

  it("always renders the light design, disabling the email's own dark-mode rules", () => {
    const dark = buildDocument(
      "<html><head><style>.card{background:#fff}@media (prefers-color-scheme: dark){.card{background:#1B1B1B!important}}</style></head><body><div class=card>Job</div></body></html>",
      false,
    );
    expect(dark).not.toMatch(/prefers-color-scheme\s*:\s*dark/i);
    expect(dark).toContain(".card{background:#fff}");
    expect(dark).toContain('<meta name="color-scheme" content="light only">');
  });

  it("detects remote images", () => {
    expect(hasRemoteImages(hostile)).toBe(true);
    expect(hasRemoteImages("<p>hi</p><img src='data:image/png;base64,xx'>")).toBe(false);
  });
});

describe("email text extraction", () => {
  const html = "<html><head><title>x</title></head><body><!--[if mso]>junk<![endif]--><h1>October payout</h1><p>₹1,24,500 is on the way.</p></body></html>";

  it.each([
    "Please enable HTML to view this email.",
    "This email requires an HTML-enabled email client.",
    "View this email in your browser: https://x.example/v/123",
    "Your email client doesn't support HTML emails.",
    "Hello, If your email software can't display HTML, click here to view online.",
  ])("replaces the stub %j with the HTML text", (stub) => {
    expect(bestText(stub, html)).toBe("October payout\n₹1,24,500 is on the way.");
  });

  it("detects a stub even when padded with a long tracking link", () => {
    const padded = `Hello,\nIf your email software can't display HTML emails. You can view the newsletter by clicking here:\nhttps://trk.example/${"x".repeat(800)}`;
    expect(bestText(padded, html)).toBe("October payout\n₹1,24,500 is on the way.");
  });

  it("collapses HTML source formatting and skips a 'trouble viewing' header", () => {
    const newsletter = `<table><tr><td>Having
                trouble viewing this
                e-mail? <a href="#">View this online</a></td></tr>
      <tr><td><p>Now 10X   Rewards on
      brand vouchers</p></td></tr></table>`;
    expect(bestText("If your email software can't display HTML emails.", newsletter)).toBe("Now 10X Rewards on brand vouchers");
  });

  it("keeps real plain text, and falls back to HTML when there's none", () => {
    expect(bestText("Hi Ashish, can you review the proposal?", html)).toBe("Hi Ashish, can you review the proposal?");
    expect(bestText("", html)).toContain("October payout");
    expect(bestText("Please enable HTML", null)).toBe("Please enable HTML");
  });

  it("strips HTML markup that a sender put into the plain-text part", () => {
    expect(bestText('Your loan repayment bill payment was <span style="color:green">successful</span>.', null)).toBe("Your loan repayment bill payment was successful.");
    expect(bestText("Use a < b and c > d in your formula", null)).toBe("Use a < b and c > d in your formula");
  });
});
