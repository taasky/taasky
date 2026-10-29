// taasky mcp: the node as a stdio MCP server, the form Claude Code and Codex
// start by themselves. Every session talks to one node on loopback, so two
// sessions meet in the same rooms: this process only carries messages to
// http://localhost:<port>/mcp, and starts that node in the background when
// nothing answers there. No terminal to keep open, and after a reboot the
// first session brings it back.

import { spawn } from "node:child_process";
import { mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(readFileSync(join(here, "../package.json"), "utf8")).version;
const DIR = join(homedir(), ".taasky");
const PID_FILE = join(DIR, "local.pid");
const LOG_FILE = join(DIR, "local.log");
const START_MS = 15_000;

// stdout carries the protocol and nothing else.
const say = (line) => process.stderr.write(`taasky: ${line}\n`);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** The version of the node answering on `url`: null if none answers, "" if it isn't ours to tell. */
async function probe(url) {
  try {
    const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok ? (r.headers.get("x-taasky-node") ?? "") : null;
  } catch {
    return null;
  }
}

/** The node this command started earlier, if it is still running. */
function ours(port) {
  try {
    const { pid, port: p } = JSON.parse(readFileSync(PID_FILE, "utf8"));
    if (p !== port) return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

function startNode(port, args) {
  mkdirSync(DIR, { recursive: true });
  const log = openSync(LOG_FILE, "a");
  const child = spawn(process.execPath, [join(here, "taasky.mjs"), "local", ...args], {
    detached: true,
    stdio: ["ignore", log, log],
  });
  writeFileSync(PID_FILE, JSON.stringify({ pid: child.pid, port, version: VERSION }));
  child.unref();
}

/**
 * A node of this version answering on `url`. One this command started under
 * an older version is replaced; one started by hand (`taasky local`) is used
 * as it is.
 */
async function ensureNode(url, port, args) {
  const running = await probe(url);
  if (running === VERSION) return;
  if (running !== null) {
    const pid = ours(port);
    if (!pid) {
      if (running) say(`using the node ${running} already on ${url}; this is ${VERSION}`);
      return;
    }
    say(`replacing the node ${running} on ${url} with ${VERSION}`);
    process.kill(pid, "SIGTERM");
    for (let t = 0; t < START_MS && (await probe(url)) !== null; t += 200) await pause(200);
    rmSync(PID_FILE, { force: true });
  }
  // Two sessions may start at once: the second node finds the port taken and
  // exits, and both sessions wait for the first.
  startNode(port, args);
  for (let t = 0; t < START_MS; t += 200) {
    if ((await probe(url)) !== null) return;
    await pause(200);
  }
  throw new Error(`no node on ${url} after ${START_MS / 1000} s; see ${LOG_FILE}`);
}

/** Each JSON-RPC message in an answer: a JSON body, or the data of each SSE event. */
async function* messages(r) {
  const type = r.headers.get("content-type") ?? "";
  if (type.includes("text/event-stream")) {
    let buf = "";
    let data = [];
    for await (const chunk of r.body.pipeThrough(new TextDecoderStream())) {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        else if (line === "" && data.length) {
          yield data.join("\n");
          data = [];
        }
      }
    }
    if (data.length) yield data.join("\n");
  } else if (type.includes("json")) {
    const body = await r.json();
    for (const m of Array.isArray(body) ? body : [body]) yield JSON.stringify(m);
  }
}

export async function stdio(port, args) {
  const url = `http://localhost:${port}`;
  await ensureNode(url, port, args);

  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  const write = (m) => process.stdout.write(`${m}\n`);

  async function post(body, retry = true) {
    try {
      return await fetch(`${url}/mcp`, { method: "POST", headers, body });
    } catch (e) {
      // The node went away mid-session (killed, a reboot of its own): bring it back once.
      if (!retry) throw e;
      await ensureNode(url, port, args);
      return post(body, false);
    }
  }

  // Each message on its own: a `wait` read holds for up to 40 s, and the others shouldn't queue behind it.
  async function carry(line) {
    let id;
    try {
      const msg = JSON.parse(line);
      id = msg.id;
      const r = await post(line);
      if (msg.method === "initialize") {
        const session = r.headers.get("mcp-session-id");
        if (session) headers["mcp-session-id"] = session;
      }
      if (!r.ok && r.status !== 202 && !(r.headers.get("content-type") ?? "").includes("json")) {
        throw new Error(`HTTP ${r.status} from ${url}/mcp`);
      }
      for await (const m of messages(r)) {
        // Before the client sees the answer, so its next message carries the version.
        const result = msg.method === "initialize" ? JSON.parse(m).result : undefined;
        if (result?.protocolVersion) headers["mcp-protocol-version"] = result.protocolVersion;
        write(m);
      }
    } catch (e) {
      if (id !== undefined) write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message: String(e.message ?? e) } }));
      else say(String(e.message ?? e));
    }
  }

  const pending = new Set();
  for await (const line of createInterface({ input: process.stdin })) {
    if (!line.trim()) continue;
    const p = carry(line).finally(() => pending.delete(p));
    pending.add(p);
  }
  await Promise.all(pending);
}
