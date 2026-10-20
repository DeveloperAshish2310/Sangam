import { EventEmitter } from "node:events";

export type RelayEvent =
  | { type: "conversation"; id: number }
  | { type: "message"; conversationId: number; messageId: number; direction: "in" | "out" }
  | { type: "account"; id: number }
  | { type: "reset" };

const bus = new EventEmitter();
bus.setMaxListeners(100);

export const emit = (event: RelayEvent) => bus.emit("event", event);

export const liveCount = () => bus.listenerCount("event");

export function subscribe(listener: (event: RelayEvent) => void) {
  bus.on("event", listener);
  return () => void bus.off("event", listener);
}
