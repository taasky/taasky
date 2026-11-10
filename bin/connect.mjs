// taasky connect / disconnect: Taasky in every agent client on this machine,
// in one command, as many times as you like.
//
// Two servers go in. The Taasky plugin brings the hosted one
// (agent.taasky.ai, for negotiating with other people) with its skills;
// taasky-local is the node on this machine, for your own sessions. Claude Code
// and Codex get both through their own CLIs; Cursor and Claude Desktop through
// their config files. A client that isn't installed is skipped. Nothing here
// signs in: neither server has anything to sign in to.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const HOSTED = "https://agent.taasky.ai/mcp";
const MARKETPLACE = "taasky/plugin";
const PLUGIN = "taasky@taasky";
const LOCAL = "taasky-local";

function onPath(bin) {
  try {
    execFileSync("which", [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Runs a client's CLI quietly: true if it succeeded. */
function run(bin, args) {
  try {
    execFileSync(bin, args, { stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
    return true;
  } catch {
    return false;
  }
}

/** The first of these commands that succeeds, or null. */
const first = (bin, ...tries) => tries.find((args) => run(bin, args)) ?? null;

/** Claude Code and Codex: the plugin from its marketplace, and the local node. */
const CLIS = [
  {
    bin: "claude",
    name: "Claude Code",
    connect(local) {
      run("claude", ["plugin", "marketplace", "add", MARKETPLACE]);
      run("claude", ["plugin", "marketplace", "update", "taasky"]);
      // An update when it is there already (an install would leave it as it is).
      const plugin = first("claude", ["plugin", "update", PLUGIN], ["plugin", "install", PLUGIN, "--scope", "user"]);
      // An earlier connect added the node by URL: replace it.
      run("claude", ["mcp", "remove", "--scope", "user", LOCAL]);
      const node = run("claude", ["mcp", "add", "--scope", "user", LOCAL, "--", ...local]);
      return [
        plugin ? "the Taasky plugin, with its skills" : `the plugin failed: claude plugin install ${PLUGIN}`,
        node ? LOCAL : `${LOCAL} failed: claude mcp add --scope user ${LOCAL} -- ${local.join(" ")}`,
      ];
    },
    disconnect() {
      return [
        run("claude", ["plugin", "uninstall", PLUGIN, "--scope", "user"]) && "the Taasky plugin",
        run("claude", ["mcp", "remove", "--scope", "user", LOCAL]) && LOCAL,
      ];
    },
  },
  {
    bin: "codex",
    name: "Codex",
    connect(local) {
      run("codex", ["plugin", "marketplace", "add", MARKETPLACE]);
      run("codex", ["plugin", "marketplace", "upgrade", "taasky"]);
      const plugin = run("codex", ["plugin", "add", PLUGIN]);
      run("codex", ["mcp", "remove", LOCAL]);
      const node = run("codex", ["mcp", "add", LOCAL, "--", ...local]);
      return [
        plugin ? "the Taasky plugin, with its skills" : `the plugin failed: codex plugin add ${PLUGIN}`,
        node ? LOCAL : `${LOCAL} failed: codex mcp add ${LOCAL} -- ${local.join(" ")}`,
      ];
    },
    disconnect() {
      return [
        run("codex", ["plugin", "remove", PLUGIN]) && "the Taasky plugin",
        run("codex", ["mcp", "remove", LOCAL]) && LOCAL,
      ];
    },
  },
];

/**
 * Clients configured by a JSON file with `mcpServers`. Cursor takes both
 * servers; Claude Desktop's file takes only commands, so it gets the local
 * node, and the hosted one is a connector added in its settings.
 */
const FILES = [
  {
    name: "Cursor",
    file: join(homedir(), ".cursor", "mcp.json"),
    servers: (local) => ({ taasky: { url: HOSTED }, [LOCAL]: stdioEntry(local) }),
  },
  {
    name: "Claude Desktop",
    file:
      process.platform === "darwin"
        ? join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json")
        : process.platform === "win32"
          ? join(process.env.APPDATA ?? "", "Claude", "claude_desktop_config.json")
          : join(homedir(), ".config", "Claude", "claude_desktop_config.json"),
    servers: (local) => ({ [LOCAL]: stdioEntry(local) }),
    note: `for other people, add a connector in Settings → Connectors: ${HOSTED}`,
  },
];

const stdioEntry = ([command, ...args]) => ({ command, args });

/** The file's JSON: {} when there is no file, null when it isn't JSON (left alone). */
function readConfig(file) {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** False when the file can't be read as JSON: then it is the person's to edit. */
function writeServers(file, update) {
  const config = readConfig(file);
  if (!config) return false;
  config.mcpServers = update({ ...config.mcpServers });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return true;
}

/** A client is there when its config directory is. */
const installed = ({ file }) => existsSync(dirname(file));

function report(name, lines) {
  const done = lines.filter(Boolean);
  console.log(`${name}: ${done.length ? done.join("; ") : "nothing to remove"}`);
}

export function connect(local) {
  for (const cli of CLIS) {
    if (!onPath(cli.bin)) continue;
    report(cli.name, cli.connect(local));
  }
  for (const client of FILES.filter(installed)) {
    const servers = client.servers(local);
    if (!writeServers(client.file, (s) => ({ ...s, ...servers }))) {
      report(client.name, [`${client.file} isn't plain JSON, left as it is; add to its mcpServers: ${JSON.stringify(servers)}`]);
      continue;
    }
    report(client.name, [Object.keys(servers).join(" and "), client.note]);
  }
  console.log("Sessions already open pick it up after a restart.");
}

export function disconnect() {
  for (const cli of CLIS) {
    if (!onPath(cli.bin)) continue;
    report(cli.name, cli.disconnect());
  }
  for (const client of FILES.filter((c) => existsSync(c.file))) {
    const names = Object.keys(client.servers([])).filter((n) => readConfig(client.file)?.mcpServers?.[n]);
    writeServers(client.file, (s) => {
      for (const n of names) delete s[n];
      return s;
    });
    report(client.name, [names.join(" and ")]);
  }
}
