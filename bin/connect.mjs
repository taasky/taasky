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

/** Runs a client's CLI quietly: true if it succeeded. */
function run(bin, args) {
  try {
    execFileSync(bin, args, { stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
    return true;
  } catch {
    return false;
  }
}

/** The first of these commands that succeeds; otherwise the last, to show the person. */
function first(bin, tries) {
  const ok = tries.find((args) => run(bin, args));
  return ok ? null : `${bin} ${tries.at(-1).join(" ")}`;
}

/**
 * Claude Code and Codex: the plugin from its marketplace, and the local node.
 * Each try list is in order: refresh before adding, update before installing,
 * since the other way round the first one fails or does nothing on a rerun.
 */
const CLIS = [
  {
    bin: "claude",
    name: "Claude Code",
    marketplace: [
      ["plugin", "marketplace", "update", "taasky"],
      ["plugin", "marketplace", "add", MARKETPLACE],
    ],
    plugin: [
      ["plugin", "update", PLUGIN],
      ["plugin", "install", PLUGIN, "--scope", "user"],
    ],
    unplugin: ["plugin", "uninstall", PLUGIN, "--scope", "user"],
    mcp: ["mcp", "add", "--scope", "user", LOCAL, "--"],
    unmcp: ["mcp", "remove", "--scope", "user", LOCAL],
  },
  {
    bin: "codex",
    name: "Codex",
    marketplace: [
      ["plugin", "marketplace", "upgrade", "taasky"],
      ["plugin", "marketplace", "add", MARKETPLACE],
    ],
    plugin: [["plugin", "add", PLUGIN]],
    unplugin: ["plugin", "remove", PLUGIN],
    mcp: ["mcp", "add", LOCAL, "--"],
    unmcp: ["mcp", "remove", LOCAL],
  },
];

function connectCli(cli, local) {
  first(cli.bin, cli.marketplace);
  const plugin = first(cli.bin, cli.plugin);
  // An earlier connect added the node by URL: replace it.
  run(cli.bin, cli.unmcp);
  const node = first(cli.bin, [[...cli.mcp, ...local]]);
  return [
    plugin ? `the plugin failed: ${plugin}` : "the Taasky plugin, with its skills",
    node ? `${LOCAL} failed: ${node}` : LOCAL,
  ];
}

const disconnectCli = (cli) => [run(cli.bin, cli.unplugin) && "the Taasky plugin", run(cli.bin, cli.unmcp) && LOCAL];

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

const writeConfig = (file, config) => writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);

function connectFile(client, local) {
  const servers = client.servers(local);
  const config = readConfig(client.file);
  if (!config) {
    return [`${client.file} isn't plain JSON, left as it is; add to its mcpServers: ${JSON.stringify(servers)}`];
  }
  config.mcpServers = { ...config.mcpServers, ...servers };
  writeConfig(client.file, config);
  return [Object.keys(servers).join(" and "), client.note];
}

function disconnectFile(client) {
  const config = readConfig(client.file);
  const names = Object.keys(client.servers([])).filter((n) => config?.mcpServers?.[n]);
  if (!names.length) return [];
  for (const n of names) delete config.mcpServers[n];
  writeConfig(client.file, config);
  return [names.join(" and ")];
}

/** The clients on this machine: a CLI on the PATH, or a config directory. */
function present() {
  const onPath = (bin) => run("which", [bin]);
  return [
    ...CLIS.filter((c) => onPath(c.bin)).map((c) => ({
      name: c.name,
      connect: (l) => connectCli(c, l),
      disconnect: () => disconnectCli(c),
    })),
    ...FILES.filter((c) => existsSync(dirname(c.file))).map((c) => ({
      name: c.name,
      connect: (l) => connectFile(c, l),
      disconnect: () => disconnectFile(c),
    })),
  ];
}

function report(name, lines) {
  const done = lines.filter(Boolean);
  console.log(`${name}: ${done.length ? done.join("; ") : "nothing to remove"}`);
}

export function connect(local) {
  for (const c of present()) report(c.name, c.connect(local));
  console.log("Sessions already open pick it up after a restart.");
}

export function disconnect() {
  for (const c of present()) report(c.name, c.disconnect());
}
