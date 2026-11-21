import { describe, expect, it, vi } from "vitest";
import { shouldNotify } from "@/lib/notify";
import type { Conversation } from "@/lib/relay";

const convo = (id: number, channel: Conversation["channel"]) => ({ id, channel }) as Conversation;
const settings = { notifyChannels: ["whatsapp", "gmail"] as Conversation["channel"][], mutedChats: [7] };

describe("who gets notified", () => {
  it("notifies for chosen apps only", () => {
    expect(shouldNotify(convo(1, "whatsapp"), settings, null)).toBe(true);
    expect(shouldNotify(convo(1, "telegram"), settings, null)).toBe(false);
  });

  it("never notifies for muted chats", () => {
    expect(shouldNotify(convo(7, "gmail"), settings, null)).toBe(false);
  });

  it("skips the open chat only while you're looking at it", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    expect(shouldNotify(convo(2, "gmail"), settings, 2)).toBe(false);
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    expect(shouldNotify(convo(2, "gmail"), settings, 2)).toBe(true);
  });
});
