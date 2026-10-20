import { env } from "./env";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { secureHeaders } from "hono/secure-headers";
import { startAll, stopAll } from "./connectors/registry";
import { initDb } from "./db";
import { api } from "./routes";
import { repairStubTexts } from "./store";

// Connectors run lots of background work (timers, live connections). One failing task must be
// logged, not take every channel offline — Node's default is to exit on an unhandled rejection.
process.on("unhandledRejection", (reason) => console.error("[sangam] background task failed:", reason));
process.on("uncaughtException", (error) => console.error("[sangam] unexpected error:", error));

await initDb();
await repairStubTexts();

const app = new Hono();
app.use("*", secureHeaders());
// Rejects cross-site form posts; JSON requests from other origins are already blocked by CORS preflight.
app.use("*", csrf({ origin: env.allowedOrigins }));
app.route("/api", api);

const server = serve({ fetch: app.fetch, port: env.port, hostname: env.host }, (info) => {
  console.log(`[sangam] API listening on http://${info.address}:${info.port}`);
});

await startAll();

const shutdown = async () => {
  await stopAll();
  server.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
