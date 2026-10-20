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
  await client.execute("PRAGMA foreign_keys = ON");
  await migrate(db, { migrationsFolder: path.join(ROOT, "backend/db/migrations") });
}

export async function audit(action: string, detail?: string) {
  await db.insert(schema.auditLog).values({ action, detail });
}

export { schema };
