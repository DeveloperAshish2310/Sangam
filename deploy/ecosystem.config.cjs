// pm2 config for running Sangam on a server: keeps the API and the web app running, restarts
// them if they crash, and (after `pm2 startup` + `pm2 save`) starts them again after a reboot.
//
//   npm run build:server          # once, and after every update
//   pm2 start deploy/ecosystem.config.cjs
//
// Both listen on 127.0.0.1 only; nginx is the one door in (see deploy/nginx-sangam.conf).
const path = require("node:path");

const root = path.resolve(__dirname, "..");

module.exports = {
  apps: [
    {
      name: "sangam-api",
      cwd: root,
      script: "node_modules/.bin/tsx",
      args: "backend/index.ts",
      interpreter: "none",
      env: { NODE_ENV: "production" },
      // WhatsApp/Telegram reconnect on their own; a crash loop shouldn't hammer them.
      restart_delay: 5000,
      max_restarts: 20,
      kill_timeout: 10000,
      time: true,
    },
    {
      name: "sangam-web",
      cwd: root,
      script: ".output/server/index.mjs",
      env: { NODE_ENV: "production", HOST: "127.0.0.1", PORT: "8888" },
      restart_delay: 2000,
      time: true,
    },
  ],
};
