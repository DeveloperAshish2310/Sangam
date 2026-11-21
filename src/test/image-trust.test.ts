import { describe, expect, it } from "vitest";
import { emailDomain, trustedDomainFor } from "@/lib/relay";

describe("trusted image senders", () => {
  it("reads the domain from an address", () => {
    expect(emailDomain("Offers <deals@Mail.Flipkart.com>")).toBe("mail.flipkart.com");
    expect(emailDomain("no address")).toBeNull();
    expect(emailDomain(null)).toBeNull();
  });

  it("a trusted domain covers its subdomains, but not look-alikes", () => {
    expect(trustedDomainFor("mail.flipkart.com", ["flipkart.com"])).toBe("flipkart.com");
    expect(trustedDomainFor("flipkart.com", ["flipkart.com"])).toBe("flipkart.com");
    expect(trustedDomainFor("notflipkart.com", ["flipkart.com"])).toBeNull();
    expect(trustedDomainFor("flipkart.com.evil.io", ["flipkart.com"])).toBeNull();
  });
});

describe("main domain", () => {
  it("drops mail subdomains, keeping country domains whole", async () => {
    const { baseDomain } = await import("@/lib/relay");
    expect(baseDomain("rmp.flipkart.com")).toBe("flipkart.com");
    expect(baseDomain("flipkart.com")).toBe("flipkart.com");
    expect(baseDomain("mail.irctc.co.in")).toBe("irctc.co.in");
    expect(baseDomain("alerts.hdfcbank.net")).toBe("hdfcbank.net");
  });
});
