// /authorize and /callback/<provider>: the part of OAuth Taasky owns. The
// library handles discovery, client registration, tokens and the binding of
// each step to the user's browser; this file decides who the user is.
//
//   MCP client ──► GET /authorize ──► consent page (connect, or pick Google or GitHub)
//              ◄── POST /authorize ─► "connect": new Taasky user → back to the client
//                                   ─► provider: redirect to it
//   provider   ──► GET /callback/<p> ─► identity → Taasky user → back to the client
//
// "Connect" asks for nothing: an unknown service does not get to demand an
// account before the first negotiation (§10). The human is reached later,
// when a move first needs their confirmation (§8).

import {
  AuthorizationError,
  authorizationErrorRedirect,
  CimdFetchError,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { sessionUser } from "../account/session.js";
import { type Analytics, noAnalytics } from "../analytics.js";

import { userForIdentity } from "../db.js";
import { userId as newUserId } from "../ids.js";
import { consentPage, errorPage, finishConnecting } from "./pages.js";
import {
  authorizeRedirect,
  configuredUpstreams,
  exchangeCode,
  isUpstreamName,
  type UpstreamEnv,
  type UpstreamIdentity,
} from "./upstream.js";

/** What every MCP request carries after sign-in, as `ctx.props`. */
export interface AuthProps {
  userId: string;
}

/** The one scope: an agent connected to Taasky may negotiate. */
export const SCOPE = "negotiate";

export interface AuthEnv extends UpstreamEnv {
  DB: D1Database;
  PUBLIC_BASE_URL: string;
  OAUTH_PROVIDER: OAuthHelpers;
}

export async function handleAuth(
  request: Request,
  env: AuthEnv,
  a: Analytics = noAnalytics,
): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  try {
    if (pathname === "/authorize") {
      if (request.method === "GET") return await showConsent(request, env);
      if (request.method === "POST") return await submitConsent(request, env, a);
      return new Response("Method not allowed", { status: 405 });
    }
    if (pathname.startsWith("/callback/")) {
      return await finishSignIn(request, env, a, pathname.slice("/callback/".length));
    }
    return null;
  } catch (e) {
    // Only a validated client and redirect URI may be redirected to; anything
    // else is rendered here (consent-page.md, "Errors: redirect or render?").
    if (e instanceof AuthorizationError && e.redirectTo)
      return Response.redirect(e.redirectTo, 302);
    if (e instanceof AuthorizationError) return errorPage(e.description);
    if (e instanceof CimdFetchError) return errorPage("This app could not be verified.");
    throw e;
  }
}

async function showConsent(request: Request, env: AuthEnv): Promise<Response> {
  const providers = configuredUpstreams(env);
  const oauth = env.OAUTH_PROVIDER;
  const authRequest = await oauth.parseAuthRequest(request);
  const details = await oauth.describeConsent(authRequest); // first: a failed lookup leaves nothing in KV
  const consent = await oauth.beginConsent(authRequest);
  consent.headers.set("Content-Type", "text/html; charset=utf-8");
  const signedIn = (await sessionUser(env.DB, request, new Date())) !== null;
  return new Response(consentPage(details, consent.handle, providers, signedIn), {
    headers: consent.headers,
  });
}

async function submitConsent(request: Request, env: AuthEnv, a: Analytics): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const form = await request.formData();
  const handle = String(form.get("handle"));
  const decision = form.get("decision");

  // "account": the person is signed in to the account page in this browser,
  // and the agent joins the agents already there instead of starting anew.
  if (decision === "connect" || decision === "account") {
    const existing = decision === "account" ? await sessionUser(env.DB, request, new Date()) : null;
    if (decision === "account" && !existing) {
      return errorPage("You were signed out of your account. Sign in again, then reconnect.");
    }
    const approved = await oauth.approveConsent(request, handle, { scope: [SCOPE] });
    const userId = existing ?? newUserId();
    const provider = existing ? "account" : "none";
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId,
      metadata: { provider },
      scope: [SCOPE],
      props: { userId } satisfies AuthProps,
    });
    a.capture(userId, "agent_connected", { provider, client: approved.request.clientId });
    return finishConnecting(redirectTo, approved.headers);
  }

  if (!isUpstreamName(decision) || !configuredUpstreams(env).includes(decision)) {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }

  const approved = await oauth.approveConsent(request, handle, { scope: [SCOPE] });
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const { state, headers } = await oauth.beginUpstream(approved.request, {
    data: { verifier, provider: decision },
    headers: approved.headers,
  });
  headers.set(
    "Location",
    await authorizeRedirect(env, env.PUBLIC_BASE_URL, decision, state, verifier),
  );
  return new Response(null, { status: 302, headers });
}

async function finishSignIn(
  request: Request,
  env: AuthEnv,
  a: Analytics,
  provider: string,
): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const {
    request: original,
    data,
    headers,
  } = await oauth.finishUpstream<{
    verifier: string;
    provider: string;
  }>(request);
  const params = new URL(request.url).searchParams;
  const code = params.get("code");

  // The provider in the path must be the one the user picked: state is bound
  // to that choice, so a callback arriving at the other provider is refused.
  if (params.get("error") || !code || data.provider !== provider || !isUpstreamName(provider)) {
    headers.set("Location", authorizationErrorRedirect(original, "access_denied"));
    return new Response(null, { status: 302, headers });
  }

  let identity: UpstreamIdentity;
  try {
    identity = await exchangeCode(env, env.PUBLIC_BASE_URL, provider, code, data.verifier);
  } catch (e) {
    // The provider failed us, not the client: tell the client so it can retry.
    console.error(JSON.stringify({ event: "upstream_sign_in_failed", provider, error: String(e) }));
    headers.set("Location", authorizationErrorRedirect(original, "temporarily_unavailable"));
    return new Response(null, { status: 302, headers });
  }
  const userId = await userForIdentity(env.DB, identity, newUserId(), new Date().toISOString());
  const { redirectTo } = await oauth.completeAuthorization({
    request: original,
    userId,
    metadata: { provider },
    scope: [SCOPE],
    props: { userId } satisfies AuthProps,
  });
  a.capture(userId, "agent_connected", { provider, client: original.clientId });
  return finishConnecting(redirectTo, headers);
}
