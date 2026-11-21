import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import path from "node:path";
import { env, ROOT } from "../env";
import * as schema from "./schema";

const client = createClient({ url: env.dbUrl });
export const db = drizzle(client, { schema });

export async function initDb() {
  await client.execute("PRAGMA journal_mode = WAL");
  // With WAL, NORMAL is crash-safe (never corrupts) and skips a disk flush per write; that
  // matters a lot on a busy or slow disk (a home server's HDD).
  await client.execute("PRAGMA synchronous = NORMAL");
  await client.execute("PRAGMA busy_timeout = 5000");
  await client.execute("PRAGMA foreign_keys = ON");
  await migrate(db, { migrationsFolder: path.join(ROOT, "backend/db/migrations") });
}

export async function audit(action: string, detail?: string) {
  await db.insert(schema.auditLog).values({ action, detail });
}

export { schema };
