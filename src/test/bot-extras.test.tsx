import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CommandList, RichText } from "@/components/relay/BotExtras";

describe("RichText", () => {
  it("links URLs without swallowing trailing punctuation", () => {
    render(<RichText text="Track it at https://shop.example/o/42?x=1. Thanks!" />);
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("https://shop.example/o/42?x=1");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("makes /commands tappable only when a handler is given", () => {
    const onCommand = vi.fn();
    render(<RichText text={"Use /start or /help@TruecallerBot to begin"} onCommand={onCommand} />);
    fireEvent.click(screen.getByText("/help@TruecallerBot"));
    expect(onCommand).toHaveBeenCalledWith("/help@TruecallerBot");
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });

  it("leaves paths, fractions and dates alone", () => {
    render(<RichText text="See C:/Users/docs, 3/4 cup, 19/10/2026 and a/b" onCommand={() => {}} />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});

describe("CommandList", () => {
  const commands = [
    { command: "start", description: "Start the bot" },
    { command: "search", description: "Look up a number" },
    { command: "help", description: "How it works" },
  ];

  it("filters by what was typed and sends the picked command", () => {
    const onPick = vi.fn();
    render(<CommandList commands={commands} filter="/s" onPick={onPick} />);
    expect(screen.queryByText("help")).toBeNull();
    fireEvent.click(screen.getByText("search"));
    expect(onPick).toHaveBeenCalledWith("/search");
  });
});
