import { describe, expect, it } from "vitest";
import { clip } from "@/hooks/use-relay";

describe("notification text clipping", () => {
  it("keeps short text as is", () => {
    expect(clip("Hi Ashish", 140)).toBe("Hi Ashish");
  });

  it("flattens line breaks and extra spaces into one line", () => {
    expect(clip("Hello,\n\n  your   order\tshipped", 140)).toBe("Hello, your order shipped");
  });

  it("cuts long text to the limit with an ellipsis", () => {
    const long = "word ".repeat(200);
    const out = clip(long, 140);
    expect(out.length).toBeLessThanOrEqual(140);
    expect(out.endsWith("…")).toBe(true);
  });
});
