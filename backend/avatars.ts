import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db, schema } from "./db";
import { DATA_DIR } from "./env";
import { emit } from "./events";

// Profile photos live next to the database, one small JPEG per conversation.
const AVATAR_DIR = path.join(DATA_DIR, "avatars");
mkdirSync(AVATAR_DIR, { recursive: true });

const fileFor = (conversationId: number) => path.join(AVATAR_DIR, `${Math.trunc(conversationId)}.jpg`);

/** Saves a conversation's photo; the stored version tag lets browsers cache it until it changes. */
export async function saveAvatar(conversationId: number, image: Buffer) {
  const version = createHash("sha1").update(image).digest("hex").slice(0, 12);
  await writeFile(fileFor(conversationId), image);
  await db.update(schema.conversations).set({ avatar: version }).where(eq(schema.conversations.id, conversationId));
  emit({ type: "conversation", id: conversationId });
}

export async function clearAvatar(conversationId: number) {
  await rm(fileFor(conversationId), { force: true });
  await db.update(schema.conversations).set({ avatar: null }).where(eq(schema.conversations.id, conversationId));
}

export const readAvatar = (conversationId: number) => readFile(fileFor(conversationId)).catch(() => null);
