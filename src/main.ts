// A Taasky node on plain Node.js: the same core as mcp.taasky.ai (core/, synced
// from taasky-mcp), with D1, KV, rate limits, static files and the hourly tick
// supplied here instead of by Cloudflare. One process, one SQLite file.

import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import worker from "../core/src/index.js";
import { config } from "./config.js";
import { SqliteD1 } from "./d1.js";
import { SqliteKV } from "./kv.js";
import { Limiter } from "./limiter.js";
import { serveStatic } from "./static.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const cfg = config(process.env);

const db = new SqliteD1(cfg.dbFile);
// schema.sql is idempotent (CREATE … IF NOT EXISTS): a new file gets every table, an old one keeps its rows.
db.sqlite.exec(readFileSync(join(root, "core/schema.sql"), "utf8"));
const kv = new SqliteKV(db);

const env = {
  DB: db,
  OAUTH_KV: kv,
  AUTH_LIMITER: new Limiter(cfg.authPerMinute),
  MCP_LIMITER: new Limiter(cfg.mcpPerMinute),
  PUBLIC_BASE_URL: cfg.baseUrl,
  // One host: invitations, rooms and /mcp live side by side.
  APP_BASE_URL: cfg.baseUrl,
  ...(cfg.devMode ? { DEV_MODE: "1" } : {}),
  ...(cfg.oneHuman ? { ONE_HUMAN: "1" } : {}),
  ...(cfg.telegramBotToken ? { TELEGRAM_BOT_TOKEN: cfg.telegramBotToken } : {}),
  ADMIN_USERS: "",
  INTERNAL_USERS: "",
};

function context() {
  return {
    waitUntil(p: Promise<unknown>) {
      p.catch((e) => console.error(JSON.stringify({ event: "background_failed", error: String(e) })));
    },
    passThroughOnException() {},
    props: {},
  };
}

async function toRequest(req: IncomingMessage): Promise<Request> {
  const url = new URL(req.url ?? "/", cfg.baseUrl);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) headers.append(k, one);
  }
  // The core keys its limits on CF-Connecting-IP. Behind a proxy, trust its header only when told to.
  const forwarded = cfg.trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim() : "";
  headers.set("CF-Connecting-IP", forwarded || req.socket.remoteAddress || "unknown");
  const method = req.method ?? "GET";
  const body = method === "GET" || method === "HEAD" ? undefined : (req as unknown as ReadableStream);
  return new Request(url, { method, headers, body, duplex: "half" } as RequestInit);
}

async function send(res: ServerResponse, r: Response) {
  const headers: Record<string, string | string[]> = {};
  r.headers.forEach((v, k) => {
    if (k === "set-cookie") return;
    headers[k] = v;
  });
  const cookies = r.headers.getSetCookie();
  if (cookies.length) headers["set-cookie"] = cookies;
  res.writeHead(r.status, headers);
  if (!r.body) return res.end();
  // Streamable HTTP answers as a stream (SSE): pass it through as it comes.
  for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk);
  res.end();
}

const server = createServer(async (req, res) => {
  try {
    const request = await toRequest(req);
    const asset = await serveStatic(join(root, "core/public"), request);
    await send(res, asset ?? (await worker.fetch(request, env as never, context() as never)));
  } catch (e) {
    console.error(JSON.stringify({ event: "request_failed", error: String(e), stack: (e as Error).stack }));
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "internal" }));
  }
});

// Rooms that ran out are closed and their humans told: the Worker's hourly cron.
async function tick() {
  try {
    await worker.scheduled({ cron: "0 * * * *", scheduledTime: Date.now(), noRetry() {} } as never, env as never, context() as never);
    kv.sweep();
  } catch (e) {
    console.error(JSON.stringify({ event: "tick_failed", error: String(e) }));
  }
}
const timer = setInterval(tick, cfg.tickMs);

server.listen(cfg.port, cfg.host, () => {
  console.log(JSON.stringify({ event: "listening", url: cfg.baseUrl, mcp: `${cfg.baseUrl}/mcp`, db: cfg.dbFile, dev: cfg.devMode, confirmations: cfg.confirmations, oneHuman: cfg.oneHuman }));
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    clearInterval(timer);
    server.close(() => {
      db.sqlite.close();
      process.exit(0);
    });
  });
}
