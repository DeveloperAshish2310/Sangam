import { mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "./env";

// Downloaded/sent attachment bytes, one file per attachment row (named by id, never by the
// sender-supplied filename, so a hostile name can't escape this folder).
const DIR = path.join(DATA_DIR, "attachments");
mkdirSync(DIR, { recursive: true });

const fileFor = (id: number) => path.join(DIR, String(Math.trunc(id)));

export const writeAttachmentFile = (id: number, data: Buffer) => writeFile(fileFor(id), data);
export const readAttachmentFile = (id: number) => readFile(fileFor(id)).catch(() => null);
