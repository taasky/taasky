#!/usr/bin/env node
// taasky local    a node on this machine, for your own sessions: Claude Code,
//                 Codex, a worktree and the session already open. Loopback
//                 only, one SQLite file in ~/.taasky, nothing leaves the machine.
// taasky connect  adds that node to Claude Code and Codex as the MCP server
//                 "taasky-local", for every project.
// taasky          the node as configured by its environment (see .env.example).

import { execFileSync } from "node:child_process";
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

function onPath(bin) {
  try {
    execFileSync("which", [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

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
  });
  console.log(`Taasky on this machine: ${url}/mcp`);
  console.log("Not connected yet? In another terminal: npx taasky connect");
  await import("../dist/main.js");
} else if (command === "connect") {
  const mcp = `${url}/mcp`;
  const steps = [
    ["claude", ["mcp", "add", "--transport", "http", "--scope", "user", "taasky-local", mcp]],
    ["codex", ["mcp", "add", "taasky-local", "--url", mcp]],
  ];
  for (const [bin, args] of steps) {
    if (!onPath(bin)) {
      console.log(`${bin}: not installed, skipped`);
      continue;
    }
    try {
      execFileSync(bin, args, { stdio: "inherit" });
      console.log(`${bin}: taasky-local → ${mcp}`);
    } catch {
      console.log(`${bin}: could not add it (already there?). By hand: ${bin} ${args.join(" ")}`);
    }
  }
} else if (command === "start") {
  await import("../dist/main.js");
} else {
  console.error("Usage: taasky [local | connect] [--port 8790]");
  process.exit(2);
}
