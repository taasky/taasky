import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";

import type { AdminEnv } from "./account/admin.js";
import { type AccountDeps, finishAccountSignIn, handleAccount } from "./account/routes.js";
import { type Analytics, type AnalyticsEnv, analytics } from "./analytics.js";
import { type AuthEnv, type AuthProps, handleAuth, SCOPE } from "./auth/handler.js";
import { issueKey, userForKey } from "./auth/keys.js";
import * as db from "./db.js";
import { expireRooms } from "./expiry.js";
import { type FormsEnv, handleForms, sendLead } from "./forms.js";
import { onItsHost } from "./hosts.js";
import { resolveHumanMove } from "./moves.js";
import { logNotifier, type Notifier } from "./notifier.js";
import { observed } from "./observe.js";
import { MoveError } from "./protocol/state.js";
import { type Caller, createServer, type Env as ServerEnv } from "./server.js";
import {
  bindUrl,
  chatOf,
  handleWebhook,
  sayClaimed,
  setupWebhook,
  signInUrl,
  telegramNotifier,
  WEBHOOK_PATH,
} from "./telegram.js";
import { handleConfirm, webNotifier } from "./web/confirm.js";
import { handleWeb } from "./web/routes.js";
import { apiCatalog, openaiAppsChallenge, skillsIndex } from "./wellknown.js";

type Env = ServerEnv &
  AuthEnv &
  AnalyticsEnv &
  AdminEnv &
  FormsEnv & {
    OAUTH_KV: KVNamespace;
    AUTH_LIMITER: RateLimit;
    MCP_LIMITER: RateLimit;
    TELEGRAM_BOT_TOKEN?: string;
    /**
     * "web": humans confirm on the web card (src/web/confirm.ts), even with a
     * bot configured. For a node, where the card must not leave the perimeter.
     */
    CONFIRMATIONS?: string;
    /** The leads bot and chat (secrets): a message per form submission. */
    LEADS_TELEGRAM_BOT_TOKEN?: string;
    LEADS_TELEGRAM_CHAT_ID?: string;
    /** The OpenAI plugin portal's domain challenge token (wrangler.jsonc vars, once issued). */
    OPENAI_APPS_CHALLENGE?: string;
  };

const ROOM_POLL = /^\/[pr]\/[a-z0-9]{26}\/v$/;

/**
 * /mcp without credentials is keyless: the agent connects with nothing and
 * gets a room token per negotiation. With a bearer token it is the signed-in
 * server, as before. /mcp/account always asks for one — the address for an
 * agent that should sign in to an account, since a client starts OAuth only
 * when told 401.
 */
const ACCOUNT_MCP = "/mcp/account";

/** True when `key` is over its limit. See the ratelimits block in wrangler.jsonc. */
async function overLimit(limiter: RateLimit, key: string): Promise<boolean> {
  return !(await limiter.limit({ key })).success;
}

const tooMany = () =>
  Response.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": "60" } });

/**
 * TEMPORARY, local only. Lets `npm run smoke` and manual testing act as any
 * user without a browser sign-in. Answers only under `wrangler dev`
 * (DEV_MODE=1); in production every /mcp request goes through OAuth.
 */
function devUser(request: Request, env: Env): string | null {
  if (env.DEV_MODE !== "1") return null;
  return request.headers.get("X-Taasky-Dev-User");
}

/**
 * Local only. Stands in for the Telegram buttons of §8 when no bot token is
 * set. The card is in the worker log; POST {"decision": "confirm" |
 * "decline"} is the human's answer. No MCP tool reaches this route — that is
 * what keeps approve out of the agent's hands.
 */
async function devConfirm(request: Request, env: Env, id: string): Promise<Response> {
  const header = devUser(request, env);
  if (!header) return Response.json({ error: "unauthenticated" }, { status: 401 });
  // A keyless agent's user is minted per room, so a script cannot know it.
  const user = header === "keyless" ? await db.ownerOfPendingMove(env.DB, id) : header;
  if (!user) return Response.json({ error: "no such pending move" }, { status: 404 });
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const body = (await request.json().catch(() => null)) as { decision?: unknown } | null;
  const decision = body?.decision;
  if (decision !== "confirm" && decision !== "decline") {
    return Response.json({ error: 'decision must be "confirm" or "decline"' }, { status: 400 });
  }
  try {
    return Response.json(await resolveHumanMove(env.DB, user, id, decision, new Date()));
  } catch (e) {
    if (e instanceof MoveError) return Response.json({ error: e.message }, { status: 409 });
    throw e;
  }
}

async function mcp(request: Request, env: Env, ctx: ExecutionContext, caller: Caller) {
  const key =
    "userId" in caller
      ? caller.userId
      : `ip:${request.headers.get("CF-Connecting-IP") ?? "unknown"}`;
  if (await overLimit(env.MCP_LIMITER, key)) return tooMany();
  // createMcpHandler builds a server per request — stateless, so env and
  // the caller's identity are closed over rather than stored anywhere.
  const a = analytics(env, ctx);
  return createMcpHandler(() => createServer(env, caller, notifier(env, a), a), {
    route: new URL(request.url).pathname,
  })(request, env, ctx);
}

/**
 * The web card when asked for; else Telegram when the bot is configured;
 * locally, the log and /dev/confirm.
 */
function channel(env: Env, a?: Analytics): Notifier {
  if (env.CONFIRMATIONS === "web") return webNotifier(env);
  const token = env.TELEGRAM_BOT_TOKEN;
  return token ? telegramNotifier({ ...env, TELEGRAM_BOT_TOKEN: token }, a) : logNotifier;
}

/** The human's channel, observed. */
function notifier(env: Env, a: Analytics): Notifier {
  return observed(channel(env, a), a, env.DB);
}

function accountDeps(env: Env, a: Analytics): AccountDeps {
  const token = env.TELEGRAM_BOT_TOKEN;
  const tg = token ? { ...env, TELEGRAM_BOT_TOKEN: token } : null;
  return {
    ...env,
    analytics: a,
    telegramSignInUrl: tg ? () => signInUrl(tg) : null,
    bindUrl: tg ? (userId) => bindUrl(tg, userId) : null,
    claimed: tg ? (chatId, deals) => sayClaimed(tg, chatId, deals) : null,
    telegramChat: tg ? (chatId) => chatOf(tg, chatId) : null,
  };
}

/** Everything OAuth does not protect: sign-in pages, key issuing, invites, health. */
const publicRoutes: ExportedHandler<Env> = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const a = analytics(env, ctx);

    if (url.pathname === "/.well-known/api-catalog") return apiCatalog(env.PUBLIC_BASE_URL);
    if (url.pathname === "/.well-known/agent-skills/index.json") return skillsIndex();
    if (url.pathname === "/.well-known/openai-apps-challenge") {
      return openaiAppsChallenge(env.OPENAI_APPS_CHALLENGE);
    }

    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "taasky-mcp", version: "0.1.0" });
    }

    const form = await handleForms(request, env, (message) => {
      const { LEADS_TELEGRAM_BOT_TOKEN: token, LEADS_TELEGRAM_CHAT_ID: chat } = env;
      if (token && chat) ctx.waitUntil(sendLead(token, chat, message));
      // Without the leads bot, the form still works; the log never holds the lead itself.
      else console.log(JSON.stringify({ event: "lead_unsent" }));
    });
    if (form) return form;

    const account = await handleAccount(request, accountDeps(env, a));
    if (account) return account;

    const confirm = await handleConfirm(request, env);
    if (confirm) return confirm;

    // Invite links are handed to humans, so they land in a browser first.
    const web = await handleWeb(request, {
      DB: env.DB,
      PUBLIC_BASE_URL: env.PUBLIC_BASE_URL,
      APP_BASE_URL: env.APP_BASE_URL,
      notifier: notifier(env, a),
      bindUrl: env.TELEGRAM_BOT_TOKEN
        ? (userId) => bindUrl({ ...env, TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN! }, userId)
        : undefined,
    });
    if (web) return web;

    if (url.pathname === WEBHOOK_PATH || url.pathname === "/telegram/setup") {
      const token = env.TELEGRAM_BOT_TOKEN;
      if (!token) return new Response("Not found", { status: 404 });
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      const tg = { ...env, TELEGRAM_BOT_TOKEN: token };
      if (url.pathname === WEBHOOK_PATH) {
        return handleWebhook(request, tg, { notifier: notifier(env, a), analytics: a });
      }
      // Run once after deploy; it can only point the bot at this Worker.
      await setupWebhook(tg);
      return Response.json({ ok: true, webhook: `${env.PUBLIC_BASE_URL}${WEBHOOK_PATH}` });
    }

    // POST only, so a link preview or crawler never mints an account.
    if (url.pathname === "/keys") {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      const { key, userId } = await issueKey(env.DB, new Date());
      a.capture(userId, "key_issued");
      return Response.json(
        {
          key,
          mcp_url: `${env.PUBLIC_BASE_URL}/mcp`,
          next: "Send it as `Authorization: Bearer <key>` on every request to mcp_url.",
          note: "Shown once and not recoverable. Anyone holding it acts as you.",
        },
        { status: 201, headers: { "Cache-Control": "no-store" } },
      );
    }

    if (url.pathname.startsWith("/dev/confirm/")) {
      return devConfirm(request, env, url.pathname.slice("/dev/confirm/".length));
    }

    if (url.pathname.startsWith("/callback/")) {
      const done = await finishAccountSignIn(
        request,
        accountDeps(env, a),
        url.pathname.slice("/callback/".length),
      );
      if (done) return done;
    }

    return (await handleAuth(request, env, a)) ?? new Response("Not found", { status: 404 });
  },
};

// The provider's options name the resource by its public URL, which comes from
// env, so it is built on first request rather than at module load.
let provider: OAuthProvider<Env> | null = null;
function oauth(env: Env): OAuthProvider<Env> {
  provider ??= new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: {
      fetch: (request, env, ctx) =>
        mcp(request, env, ctx, {
          userId: (ctx as ExecutionContext & { props: AuthProps }).props.userId,
        }),
    },
    defaultHandler: publicRoutes,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    // Hermes and OpenClaw register dynamically; Claude uses a metadata document.
    clientRegistrationEndpoint: "/oauth/register",
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: [SCOPE, "offline_access"],
    requiredScopes: [SCOPE],
    // Bearer tokens the provider did not issue: our static keys from POST /keys.
    resolveExternalToken: async ({ token, env }) => {
      const userId = await userForKey(env.DB, token);
      if (!userId) return null;
      return { props: { userId } satisfies AuthProps, audience: `${env.PUBLIC_BASE_URL}/mcp` };
    },
    resourceMetadata: {
      resource: `${env.PUBLIC_BASE_URL}/mcp`,
      authorization_servers: [env.PUBLIC_BASE_URL],
      resource_name: "Taasky",
    },
  });
  return provider;
}

const worker = {
  /** Hourly (wrangler.jsonc triggers): rooms that ran out are closed and their humans told. */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const a = analytics(env, ctx);
    const result = await expireRooms(env.DB, channel(env), a, new Date());
    console.log(JSON.stringify({ event: "rooms_expired", ...result }));
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const elsewhere = onItsHost(request, env);
    if (elsewhere) return elsewhere;
    const { pathname } = new URL(request.url);
    const isMcp = pathname === "/mcp" || pathname === ACCOUNT_MCP;
    if (isMcp) {
      const user = devUser(request, env);
      if (user) return mcp(request, env, ctx, { userId: user });
      if (pathname === "/mcp" && !request.headers.has("Authorization")) {
        return mcp(request, env, ctx, { keyless: true });
      }
    } else if (pathname !== "/health" && pathname !== WEBHOOK_PATH && !ROOM_POLL.test(pathname)) {
      // The webhook is exempt: every human's button press arrives from a few
      // Telegram IPs, and the secret header already keeps strangers out. So is
      // the room page's 5-second poll: one read, and it would eat the budget.
      const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
      if (await overLimit(env.AUTH_LIMITER, ip)) return tooMany();
    }
    const res = await oauth(env).fetch(request, env, ctx);
    return isMcp && res.status === 401 ? withKeyHint(res, env) : res;
  },
} satisfies ExportedHandler<Env>;

export default {
  scheduled: worker.scheduled,
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return withHsts(await worker.fetch(request, env, ctx), request);
  },
} satisfies ExportedHandler<Env>;

/** Browsers that have seen mcp.taasky.ai once never try it over plain HTTP again. */
function withHsts(res: Response, request: Request): Response {
  if (res.status === 101 || !request.url.startsWith("https:")) return res;
  const out = new Response(res.body, res);
  out.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  return out;
}

/**
 * An agent that probes /mcp and cannot finish a browser sign-in — it runs on
 * a server, so OAuth's loopback redirect never reaches it — would otherwise
 * drag its human through copying a code out of an address bar. The 401 tells
 * it the way it can take alone. Headers, WWW-Authenticate among them, stay.
 */
async function withKeyHint(res: Response, env: Env): Promise<Response> {
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(await res.text());
  } catch {
    // An empty body: nothing to keep.
  }
  body.error ??= "unauthorized";
  body.hint =
    "Sign in with OAuth (see WWW-Authenticate). If you cannot complete a browser sign-in " +
    `(for example, you run on a server), POST ${env.PUBLIC_BASE_URL}/keys, no body needed, and ` +
    "send the returned key as `Authorization: Bearer <key>`. Your human confirms in Telegram later. " +
    `Or connect to ${env.PUBLIC_BASE_URL}/mcp with no Authorization header at all: Taasky works ` +
    "without an account, one room token per negotiation.";
  const headers = new Headers(res.headers);
  headers.set("Content-Type", "application/json");
  headers.delete("Content-Length");
  return new Response(JSON.stringify(body), { status: 401, headers });
}
