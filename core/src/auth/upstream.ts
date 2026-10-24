// Who the person is, as Google or GitHub vouches for it. Taasky has no
// passwords: connecting the MCP server signs the user in through one of these
// and that sign-in is the registration (PROTOCOL.md §10). Nothing but identity
// is asked for, and the upstream token is dropped once the profile is read —
// Taasky never calls these APIs on the user's behalf.

export interface UpstreamEnv {
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
}

export interface UpstreamIdentity {
  provider: UpstreamName;
  /** The provider's stable id for the person; never their email, which can change hands. */
  subject: string;
  email: string | null;
  name: string | null;
}

interface Upstream {
  label: string;
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
  credentials(env: UpstreamEnv): { id: string; secret: string } | null;
  profile(accessToken: string): Promise<Omit<UpstreamIdentity, "provider">>;
}

export const UPSTREAMS = {
  google: {
    label: "Google",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scope: "openid email profile",
    credentials: (env) =>
      env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? { id: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET }
        : null,
    async profile(token) {
      const me = await getJson<{
        sub: string;
        email?: string;
        email_verified?: boolean;
        name?: string;
      }>("https://openidconnect.googleapis.com/v1/userinfo", token);
      return {
        subject: me.sub,
        email: me.email_verified ? (me.email ?? null) : null,
        name: me.name ?? null,
      };
    },
  },
  github: {
    label: "GitHub",
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    // Public profile only. No scope reaches repositories or private email.
    scope: "",
    credentials: (env) =>
      env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
        ? { id: env.GITHUB_CLIENT_ID, secret: env.GITHUB_CLIENT_SECRET }
        : null,
    async profile(token) {
      const me = await getJson<{
        id: number;
        login: string;
        name: string | null;
        email: string | null;
      }>("https://api.github.com/user", token);
      return { subject: String(me.id), email: me.email, name: me.name ?? me.login };
    },
  },
} satisfies Record<string, Upstream>;

export type UpstreamName = keyof typeof UPSTREAMS;

export function isUpstreamName(x: unknown): x is UpstreamName {
  return typeof x === "string" && Object.hasOwn(UPSTREAMS, x);
}

/** The providers this deployment has credentials for, in display order. */
export function configuredUpstreams(env: UpstreamEnv): UpstreamName[] {
  return (Object.keys(UPSTREAMS) as UpstreamName[]).filter((n) => UPSTREAMS[n].credentials(env));
}

export function callbackUrl(baseUrl: string, name: UpstreamName): string {
  return `${baseUrl}/callback/${name}`;
}

export async function authorizeRedirect(
  env: UpstreamEnv,
  baseUrl: string,
  name: UpstreamName,
  state: string,
  verifier: string,
): Promise<string> {
  const up = UPSTREAMS[name];
  const creds = up.credentials(env);
  if (!creds) throw new Error(`${name} sign-in is not configured`);
  const url = new URL(up.authorizeUrl);
  url.searchParams.set("client_id", creds.id);
  url.searchParams.set("redirect_uri", callbackUrl(baseUrl, name));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", await s256(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  if (up.scope) url.searchParams.set("scope", up.scope);
  return url.toString();
}

export async function exchangeCode(
  env: UpstreamEnv,
  baseUrl: string,
  name: UpstreamName,
  code: string,
  verifier: string,
): Promise<UpstreamIdentity> {
  const up = UPSTREAMS[name];
  const creds = up.credentials(env);
  if (!creds) throw new Error(`${name} sign-in is not configured`);
  const res = await fetch(up.tokenUrl, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: creds.id,
      client_secret: creds.secret,
      redirect_uri: callbackUrl(baseUrl, name),
      code_verifier: verifier,
    }),
  });
  // GitHub reports failures as 200 with an `error` field.
  const body = (await res.json()) as { access_token?: string; error?: string };
  if (!res.ok || !body.access_token) {
    throw new Error(`${up.label} token exchange failed: ${body.error ?? res.status}`);
  }
  return { provider: name, ...(await up.profile(body.access_token)) };
}

async function getJson<T>(url: string, token: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "User-Agent": "taasky-mcp", // GitHub refuses requests without one
    },
  });
  if (!res.ok) throw new Error(`${new URL(url).hostname} profile request failed: ${res.status}`);
  return (await res.json()) as T;
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
