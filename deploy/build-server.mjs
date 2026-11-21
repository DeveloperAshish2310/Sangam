// `npm run build:server`: the production build for the server, on Linux or Windows.
// Sets the env vars itself (cmd.exe has no `VAR=value cmd` syntax) and defaults the sub-path to
// /unified-ChatBox/ (Git Bash would also turn a typed "/unified-ChatBox/" into a Windows path).
// Override with SANGAM_BASE=/ for a root-path build.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const vite = path.join(root, "node_modules/vite/bin/vite.js");
const env = {
  ...process.env,
  NITRO_PRESET: "node-server",
  SANGAM_BASE: process.env.SANGAM_BASE || "/unified-ChatBox/",
};
console.log(`Building for ${env.SANGAM_BASE}`);
const r = spawnSync(process.execPath, [vite, "build"], { stdio: "inherit", env, cwd: root });
process.exit(r.status ?? 1);
