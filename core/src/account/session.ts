// Who is looking at the account page. A browser proves it with a cookie that
// holds a random token; D1 keeps only the token's hash, so a database read
// cannot be replayed as a sign-in. There are no passwords: a session starts
// from a one-time link the Telegram bot sends, or from Google or GitHub.

import { sha256 } from "../auth/keys.js";
import * as db from "../db.js";
import { loginCode, sessionToken } from "../ids.js";

/** __Host-: Secure, Path=/, no Domain — the cookie cannot leak to another host. */
const COOKIE = "__Host-taasky_session";
/** The Google or GitHub round trip: provider, state and PKCE verifier, for ten minutes. */
const SIGNIN_COOKIE = "__Host-taasky_signin";

const SESSION_DAYS = 30;
const LOGIN_CODE_MINUTES = 15;

export function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function cookie(name: string, value: string, maxAge: number): string {
  // Lax: sent on a top-level navigation back from Google, never on a
  // cross-site POST — which is what keeps another site from submitting
  // the account page's forms.
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

/** Starts a session for `userId`; returns the Set-Cookie value. */
export async function startSession(d1: D1Database, userId: string, now: Date): Promise<string> {
  const token = sessionToken();
  await db.insertSession(d1, {
    token_hash: await sha256(token),
    user_id: userId,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + SESSION_DAYS * 86400_000).toISOString(),
  });
  return cookie(COOKIE, token, SESSION_DAYS * 86400);
}

/** The signed-in user, or null. */
export async function sessionUser(
  d1: D1Database,
  request: Request,
  now: Date,
): Promise<string | null> {
  const token = readCookie(request, COOKIE);
  if (!token || !/^[a-z0-9]{32}$/.test(token)) return null;
  return db.userForSession(d1, await sha256(token), now.toISOString());
}

/** Ends this browser's session; returns the Set-Cookie value that clears it. */
export async function endSession(d1: D1Database, request: Request): Promise<string> {
  const token = readCookie(request, COOKIE);
  if (token) await db.deleteSession(d1, await sha256(token));
  return cookie(COOKIE, "", 0);
}

/** A one-time sign-in link to `userId`'s account page, for the Telegram bot to send. */
export async function loginLink(
  d1: D1Database,
  baseUrl: string,
  userId: string,
  now: Date,
): Promise<string> {
  const code = loginCode();
  await db.insertLoginCode(d1, {
    code,
    user_id: userId,
    expires_at: new Date(now.getTime() + LOGIN_CODE_MINUTES * 60_000).toISOString(),
  });
  return `${baseUrl}/login/${code}`;
}

export interface PendingSignIn {
  provider: string;
  state: string;
  verifier: string;
}

export function signInCookie(p: PendingSignIn): string {
  return cookie(SIGNIN_COOKIE, `${p.provider}.${p.state}.${p.verifier}`, 600);
}

export const clearSignInCookie = () => cookie(SIGNIN_COOKIE, "", 0);

/** The account sign-in this browser started, if the callback's state is its own. */
export function pendingSignIn(request: Request, state: string | null): PendingSignIn | null {
  const raw = readCookie(request, SIGNIN_COOKIE);
  if (!raw || !state) return null;
  const [provider, ownState, verifier] = raw.split(".");
  if (!provider || !ownState || !verifier || ownState !== state) return null;
  return { provider, state, verifier };
}
