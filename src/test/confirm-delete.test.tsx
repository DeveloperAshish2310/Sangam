import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { askDelete, DeleteConfirmHost, type DeleteChoice } from "@/components/relay/ConfirmDelete";
import type { Conversation, Message } from "@/lib/relay";

const convo = (over: Partial<Conversation>): Conversation => ({
  id: 1, accountId: 1, channel: "telegram", externalId: "12345", name: "Priya", subject: null, unread: 0,
  starred: false, archived: false, tags: [], lastMessageAt: 0, avatar: null, lastMessage: null, ...over,
});
const message = (direction: "in" | "out"): Message => ({
  id: 9, conversationId: 1, direction, senderName: null, text: "hi", html: null, extra: null, attachments: [], sentAt: 0, status: "sent",
});

async function ask(...args: Parameters<typeof askDelete>) {
  render(<DeleteConfirmHost />);
  let result!: Promise<DeleteChoice | null>;
  act(() => { result = askDelete(...args); });
  return () => result;
}

describe("delete confirmation", () => {
  it("Telegram private chat: delete in Telegram, optionally for the other person too", async () => {
    const result = await ask("message", convo({}), { message: message("in") });
    expect(screen.getByText("Also delete for Priya")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByText("Delete in Telegram"));
    expect(await result()).toEqual({ scope: "everywhere", forEveryone: true });
  });

  it("Telegram group: deleting the chat is spelled out as leaving the group", async () => {
    const result = await ask("chat", convo({ externalId: "-1001234", name: "Night owls" }));
    expect(screen.getByText("Leave this group?")).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.click(screen.getByText("Leave group"));
    expect(await result()).toEqual({ scope: "everywhere", forEveryone: false });
  });

  it("someone else's message in a group can't be deleted for everyone", async () => {
    await ask("message", convo({ externalId: "-1001234" }), { message: message("in") });
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("Gmail moves to Trash; 'Remove from Sangam only' keeps it on Gmail", async () => {
    const result = await ask("chat", convo({ channel: "gmail", externalId: "thread1" }));
    expect(screen.getByText("Move to Gmail Trash")).toBeTruthy();
    expect(screen.getByText(/restore it for 30 days/)).toBeTruthy();
    fireEvent.click(screen.getByText("Remove from Sangam only"));
    expect(await result()).toEqual({ scope: "relay", forEveryone: false });
  });

  it("demo data only offers removing from Sangam, and Cancel returns nothing", async () => {
    const result = await ask("chat", convo({}), { isDemo: true });
    expect(screen.queryByText("Delete in Telegram")).toBeNull();
    fireEvent.click(screen.getByText("Cancel"));
    expect(await result()).toBeNull();
  });
});
