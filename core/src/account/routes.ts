// The account page: one place for a person's agents. It is not a gate — an
// agent still connects with one button and no account (PROTOCOL.md §10). It
// is where the same person adds a second agent to the same account, gets a
// key for an agent that cannot sign in, and takes access away.
//
//   GET  /account                    your agents, or the sign-in page
//   POST /account/signin/<provider>  Google or GitHub → /callback/<provider>
//   GET  /login/<code>               the Telegram bot's one-time link; a button…
//   POST /login/<code>               …that spends it and starts the session
//   POST /account/keys               a new key for this account, shown once
//   POST /account/keys/revoke        key=<hash>
//   POST /account/apps/revoke        grant=<id>
//   POST /account/profile            name=<text>&shown=1, the name the other side sees
//   POST /account/plus               join the Taasky Plus list
//   POST /account/signout
//   GET  /account/admin              who has an account, for ADMIN_USERS only (admin.ts)
//
// Every POST checks Origin on top of the SameSite cookie (fromOurPages).

import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Analytics } from "../analytics.js";
import { issueKey } from "../auth/keys.js";
import {
  authorizeRedirect,
  configuredUpstreams,
  exchangeCode,
  isUpstreamName,
  type UpstreamEnv,
} from "../auth/upstream.js";
import * as db from "../db.js";
import { listDeals } from "../deals.js";
import { appBase, type HostEnv } from "../hosts.js";
import { htmlResponse, page } from "../html.js";
import { userId as newUserId } from "../ids.js";
import { cleanName, firstNameAndInitial } from "../shown.js";
import type { TelegramChat } from "../telegram.js";
import { type AdminEnv, adminOverview, adminPage, isAdmin } from "./admin.js";
import { claimChat } from "./claim.js";
import {
  accountPage,
  type ConnectedApp,
  loginConfirmPage,
  newKeyPage,
  signInPage,
} from "./pages.js";
import {
  clearSignInCookie,
  endSession,
  pendingSignIn,
  sessionUser,
  signInCookie,
  startSession,
} from "./session.js";

/** The account lives on the people's host (hosts.ts); its sign-in comes back there. */
export interface AccountDeps extends UpstreamEnv, HostEnv, AdminEnv {
  DB: D1Database;
  OAUTH_PROVIDER: OAuthHelpers;
  analytics: Analytics;
  /** t.me link that opens the bot on its sign-in command, when the bot is configured. */
  telegramSignInUrl: (() => Promise<string>) | null;
  /** Telegram binding link for a user, when the bot is configured. */
  bindUrl: ((userId: string) => Promise<string>) | null;
  /** Tells the chat its deals were saved to an account, when the bot is configured. */
  claimed: ((chatId: string, deals: number) => Promise<void>) | null;
  /** The bound chat's @username and name, for showing it back to its owner. */
  telegramChat?: ((chatId: string) => Promise<TelegramChat | null>) | null;
}

/** Someone not signed in yet: a one-off id, so sign-in funnels count without a person. */
const anonymous = () => `anon:${crypto.randomUUID()}`;

/**
 * One Google or GitHub attempt, from the button to its end, under one id: a
 * hash of its OAuth state, so PostHog can join the steps but never sees the state.
 */
async function attemptId(state: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`attempt:${state}`),
  );
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `anon:${hex.slice(0, 24)}`;
}

const see = (location: string, cookies: string[] = []) => {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(null, { status: 303, headers });
};

/**
 * Whether a POST came from our own pages. Our pages send no referrer, so a
 * browser may say `Origin: null` for its own form; then Sec-Fetch-Site,
 * which a page cannot set, must say same-origin.
 */
export function fromOurPages(request: Request, baseUrl: string): boolean {
  const origin = request.headers.get("Origin");
  if (origin === null || origin === baseUrl) return true;
  return origin === "null" && request.headers.get("Sec-Fetch-Site") === "same-origin";
}

export async function handleAccount(request: Request, deps: AccountDeps): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  const login = /^\/login\/([a-z0-9]{20})$/.exec(pathname);
  if (pathname !== "/account" && !pathname.startsWith("/account/") && !login) return null;

  if (request.method === "POST") {
    if (!fromOurPages(request, appBase(deps))) {
      return new Response("Forbidden", { status: 403 });
    }
  } else if (request.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }

  const now = new Date();
  if (login) {
    if (request.method === "GET") {
      deps.analytics.capture(anonymous(), "sign_in_link_opened", { method: "telegram" });
      return htmlResponse(loginConfirmPage(login[1]!));
    }
    const userId = await db.takeLoginCode(deps.DB, login[1]!, now.toISOString());
    if (!userId) {
      deps.analytics.capture(anonymous(), "account_sign_in_failed", {
        method: "telegram",
        reason: "link_expired",
      });
      return htmlResponse(
        await showSignIn(
          deps,
          "That link has expired or was already used. Ask the bot for a new one.",
        ),
        410,
      );
    }
    deps.analytics.capture(userId, "account_signed_in", { method: "telegram" });
    return see("/account", [await startSession(deps.DB, userId, now)]);
  }

  const signin = /^\/account\/signin\/([a-z]+)$/.exec(pathname);
  if (signin && request.method === "POST") return startUpstream(deps, signin[1]!);

  const userId = await sessionUser(deps.DB, request, now);
  if (!userId) {
    if (request.method === "POST") return see("/account");
    deps.analytics.capture(anonymous(), "sign_in_viewed");
    return htmlResponse(await showSignIn(deps));
  }

  if (request.method === "GET") {
    if (pathname === "/account/admin") {
      if (!isAdmin(deps, userId)) return new Response("Not found", { status: 404 });
      return htmlResponse(adminPage(await adminOverview(deps.DB, deps)));
    }
    if (pathname !== "/account") return see("/account");
    return htmlResponse(await showAccount(deps, userId, undefined, true));
  }

  // A form without fields may arrive with no body at all.
  const form = await request.formData().catch(() => new FormData());
  switch (pathname) {
    case "/account/keys": {
      const label =
        String(form.get("label") ?? "")
          .trim()
          .slice(0, 40) || null;
      const { key } = await issueKey(deps.DB, now, { userId, label });
      deps.analytics.capture(userId, "key_issued", { source: "account" });
      return htmlResponse(newKeyPage({ key, label, mcpUrl: `${deps.PUBLIC_BASE_URL}/mcp` }));
    }
    case "/account/keys/revoke": {
      const removed = await db.deleteApiKey(deps.DB, userId, String(form.get("key") ?? ""));
      if (removed) deps.analytics.capture(userId, "key_revoked");
      return htmlResponse(
        await showAccount(deps, userId, removed ? "Key revoked. It stops working now." : undefined),
      );
    }
    case "/account/apps/revoke": {
      const grant = String(form.get("grant") ?? "");
      const owned = (await listApps(deps, userId)).some((a) => a.grantId === grant);
      if (owned) {
        await deps.OAUTH_PROVIDER.revokeGrant(grant, userId);
        deps.analytics.capture(userId, "agent_disconnected");
      }
      return htmlResponse(
        await showAccount(
          deps,
          userId,
          owned ? "Disconnected. That agent has to sign in again." : undefined,
        ),
      );
    }
    case "/account/profile": {
      const identities = await db.identitiesFor(deps.DB, userId);
      if (!identities.length) return see("/account");
      const before = await profileOf(deps.DB, userId, identities, now);
      const name = cleanName(String(form.get("name") ?? "")) ?? before.name;
      const shown = form.get("shown") === "1";
      await db.setProfile(deps.DB, userId, { name, shown });
      if (shown !== before.shown) deps.analytics.capture(userId, "name_shown_toggled", { shown });
      if (name !== before.name) deps.analytics.capture(userId, "name_changed", { shown });
      return htmlResponse(
        await showAccount(
          deps,
          userId,
          shown ? `Saved. The other side sees ${name}.` : "Saved. Your name is hidden.",
        ),
      );
    }
    case "/account/plus": {
      if (await db.joinPlusList(deps.DB, userId, now.toISOString())) {
        deps.analytics.capture(userId, "plus_list_joined");
      }
      return htmlResponse(
        await showAccount(
          deps,
          userId,
          "You're on the list. You'll hear first when Plus is ready.",
        ),
      );
    }
    case "/account/signout":
      deps.analytics.capture(userId, "signed_out");
      return see("/account", [await endSession(deps.DB, request)]);
    default:
      return new Response("Not found", { status: 404 });
  }
}

async function showSignIn(deps: AccountDeps, notice?: string): Promise<string> {
  return signInPage({
    providers: configuredUpstreams(deps),
    telegramUrl: deps.telegramSignInUrl ? await deps.telegramSignInUrl() : null,
    notice,
  });
}

async function listApps(deps: AccountDeps, userId: string): Promise<ConnectedApp[]> {
  const { items } = await deps.OAUTH_PROVIDER.listUserGrants(userId);
  return Promise.all(
    items.map(async (g) => {
      let name: string | undefined;
      try {
        name = (await deps.OAUTH_PROVIDER.lookupClient(g.clientId))?.clientName;
      } catch {
        // A metadata document that no longer resolves; the URL still names it.
      }
      return { grantId: g.id, name: name ?? clientHost(g.clientId), createdAt: g.createdAt * 1000 };
    }),
  );
}

function clientHost(clientId: string): string {
  try {
    return new URL(clientId).host;
  } catch {
    return "An app";
  }
}

async function showAccount(
  deps: AccountDeps,
  userId: string,
  notice?: string,
  viewed = false,
): Promise<string> {
  const channelP = db.getChannel(deps.DB, userId);
  const [keys, apps, channel, chat, identities, deals, account, plus] = await Promise.all([
    db.listApiKeys(deps.DB, userId),
    listApps(deps, userId),
    channelP,
    // Asked of Telegram alongside the database, never after it; chatOf gives up quickly.
    channelP.then((c) => (c && deps.telegramChat ? deps.telegramChat(c.address) : null)),
    db.identitiesFor(deps.DB, userId),
    listDeals(deps.DB, appBase(deps), [userId]),
    db.accountOf(deps.DB, userId),
    db.onPlusList(deps.DB, userId),
  ]);
  const who = identities.find((i) => i.email)?.email ?? identities[0]?.name;
  // Seeing this page is seeing the switch: rooms entered from now on show the name.
  const profile = identities.length
    ? {
        ...(await profileOf(deps.DB, userId, identities, new Date())),
        emailVerified: identities.some((i) => i.provider === "google" && i.email),
      }
    : null;
  // Came through the bot and never signed in with Google or GitHub: offer to save.
  const save = channel && !identities.length && account === userId;
  if (viewed) {
    deps.analytics.capture(userId, "account_viewed", {
      deals: deals.length,
      agents: keys.length + apps.length,
      telegram: Boolean(channel),
      signed_in_with: identities.map((i) => i.provider).join(",") || "telegram",
      name_shown: profile?.shown ?? false,
      plus,
    });
  }
  return accountPage({
    save: save ? configuredUpstreams(deps) : [],
    mcpUrl: `${deps.PUBLIC_BASE_URL}/mcp/account`,
    signedInAs: who ?? (channel ? "via Telegram" : "signed in"),
    telegram: channel
      ? { bound: true, chat }
      : { bound: false, bindUrl: deps.bindUrl ? await deps.bindUrl(userId) : null },
    keys,
    apps,
    deals,
    profile,
    plus,
    notice,
  });
}

/** The account's profile, first name and initial from a sign-in until they change it. */
function profileOf(
  d1: D1Database,
  userId: string,
  identities: { name: string | null; email: string | null }[],
  now: Date,
): Promise<db.Profile> {
  const name =
    identities.map((i) => firstNameAndInitial(i.name)).find(Boolean) ??
    firstNameAndInitial(identities.find((i) => i.email)?.email?.split("@")[0]) ??
    "Taasky user";
  return db.profileFor(d1, userId, name, now.toISOString());
}

async function startUpstream(deps: AccountDeps, provider: string): Promise<Response> {
  if (!isUpstreamName(provider) || !configuredUpstreams(deps).includes(provider)) {
    return new Response("Not found", { status: 404 });
  }
  const state = crypto.randomUUID();
  deps.analytics.capture(await attemptId(state), "sign_in_started", { method: provider });
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const location = await authorizeRedirect(deps, appBase(deps), provider, state, verifier);
  return see(location, [signInCookie({ provider, state, verifier })]);
}

/**
 * /callback/<provider> serves both sign-ins: an agent's OAuth and this page's.
 * The page's carries the state it put in its own cookie; anything else is left
 * to the OAuth library (null).
 */
export async function finishAccountSignIn(
  request: Request,
  deps: AccountDeps,
  provider: string,
): Promise<Response | null> {
  const params = new URL(request.url).searchParams;
  const pending = pendingSignIn(request, params.get("state"));
  if (!pending) return null;

  const code = params.get("code");
  if (!code || pending.provider !== provider || !isUpstreamName(provider)) {
    deps.analytics.capture(await attemptId(pending.state), "account_sign_in_failed", {
      method: provider,
      reason: "cancelled",
    });
    return htmlResponse(await showSignIn(deps, "Sign-in was cancelled."), 400, {
      "Set-Cookie": clearSignInCookie(),
    });
  }
  const now = new Date();
  let userId: string;
  try {
    const identity = await exchangeCode(deps, appBase(deps), provider, code, pending.verifier);
    userId = await db.userForIdentity(deps.DB, identity, newUserId(), now.toISOString());
  } catch (e) {
    console.error(JSON.stringify({ event: "account_sign_in_failed", provider, error: String(e) }));
    deps.analytics.capture(await attemptId(pending.state), "account_sign_in_failed", {
      method: provider,
      reason: "exchange",
    });
    return htmlResponse(
      page("Sign-in failed", `<h1>Could not sign in</h1><p class="lede">Please try again.</p>`, {
        narrow: true,
      }),
      502,
      { "Set-Cookie": clearSignInCookie() },
    );
  }
  deps.analytics.capture(userId, "account_signed_in", { method: provider });
  deps.analytics.capture(await attemptId(pending.state), "sign_in_completed", { method: provider });
  // Signed in from a session that came through the bot: that chat's deals
  // become this account's (docs/accounts.md, the claim). A failure here
  // leaves the sign-in done.
  const from = await sessionUser(deps.DB, request, now);
  const claim =
    from &&
    (await claimChat(deps.DB, from, userId, now).catch((e) => {
      console.error(JSON.stringify({ event: "claim_failed", error: String(e) }));
      return null;
    }));
  if (claim) {
    deps.analytics.capture(userId, "claim_done", { linked: claim.linked, deals: claim.deals });
    await deps
      .claimed?.(claim.chatId, claim.deals)
      .catch((e) =>
        console.error(JSON.stringify({ event: "claim_notify_failed", error: String(e) })),
      );
  }
  return see("/account", [clearSignInCookie(), await startSession(deps.DB, userId, now)]);
}
