#!/usr/bin/env node
// taasky local    a node on this machine, for your own sessions: Claude Code,
//                 Codex, a worktree and the session already open. Loopback
//                 only, one SQLite file in ~/.taasky, nothing leaves the machine.
// taasky mcp      the same node for one session, over stdio: starts it in the
//                 background if it isn't running, then carries the session's
//                 messages to it (bin/stdio.mjs).
// taasky connect  Taasky in Claude Code, Codex, Cursor and Claude Desktop: the
//                 Taasky plugin (hosted server and skills) and `taasky mcp` as
//                 "taasky-local" (bin/connect.mjs). The only step there is.
// taasky disconnect  takes both out again.
// taasky          the node as configured by its environment (see .env.example).

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The OAuth provider tells Workers how to turn CIMD on. A node has no
// wrangler.jsonc and keeps CIMD off, so the hint only confuses.
const warn = console.warn;
console.warn = (...args) => {
  if (!String(args[0]).startsWith("CIMD (Client ID Metadata Document) is disabled")) warn(...args);
};

const [command = "start", ...rest] = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 && rest[i + 1] ? rest[i + 1] : fallback;
};
const port = flag("port", process.env.PORT ?? "8790");
const url = `http://localhost:${port}`;

if (command === "local") {
  const dir = join(homedir(), ".taasky");
  mkdirSync(dir, { recursive: true });
  Object.assign(process.env, {
    PORT: port,
    HOST: "127.0.0.1",
    TAASKY_BASE_URL: url,
    TAASKY_DB: flag("db", join(dir, "local.sqlite")),
    TAASKY_CONFIRMATIONS: "web",
    TELEGRAM_BOT_TOKEN: "",
    TAASKY_DEV_MODE: "0",
    // Every seat is you: one page and one yes for both sessions.
    TAASKY_ONE_HUMAN: "1",
  });
  console.log(`Taasky on this machine: ${url}/mcp`);
  await import("../dist/main.js");
} else if (command === "mcp") {
  const { stdio } = await import("./stdio.mjs");
  await stdio(port, rest);
} else if (command === "connect") {
  // The sessions start the node themselves; a port other than the default goes along.
  const { connect } = await import("./connect.mjs");
  connect(["npx", "-y", "@taasky/taasky", "mcp", ...(port === "8790" ? [] : ["--port", port])]);
} else if (command === "disconnect") {
  const { disconnect } = await import("./connect.mjs");
  disconnect();
} else if (command === "start") {
  await import("../dist/main.js");
} else {
  console.error("Usage: taasky [connect | disconnect | mcp | local] [--port 8790]");
  process.exit(2);
}
