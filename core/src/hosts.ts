// Two hosts, one Worker. People use app.taasky.ai: the account, invitations
// and rooms. Agents use mcp.taasky.ai: /mcp, OAuth and the discovery files.
// Each host sends the other's paths across, so an old link keeps working.
// Without APP_BASE_URL (`npm run dev`) both are one host and nothing moves.
//
// A third, agent.taasky.ai, is /mcp with no sign-in at all, for the plugin and
// `taasky connect`. mcp.taasky.ai advertises OAuth for connectors (claude.ai,
// ChatGPT), and a client that finds it offers an "Authenticate" that Taasky
// never needs; on agent.taasky.ai there is nothing to find.

export interface HostEnv {
  /** The agents' host: issuer, resource, /mcp. */
  PUBLIC_BASE_URL: string;
  /** The people's host; defaults to PUBLIC_BASE_URL. */
  APP_BASE_URL?: string;
  /** The keyless agents' host: /mcp and nothing to sign in to. */
  AGENT_BASE_URL?: string;
}

/** Where links meant for a person point. */
export const appBase = (env: HostEnv) => env.APP_BASE_URL ?? env.PUBLIC_BASE_URL;

/** Pages for people: the account, the bot's sign-in links, invitations, rooms and their poll, the site's forms. */
const FOR_PEOPLE =
  /^\/(?:account(?:\/.*)?|login\/[a-z0-9]{20}|[ipr]\/[a-z0-9]+(?:\/v|\/calendar\.ics)?|forms\/(?:early-access|waitlist))$/;

/** Both hosts finish a sign-in: an account's on the app, an agent's OAuth on mcp. */
const EITHER = /^\/(?:callback\/[a-z]+|health)$/;

/**
 * The redirect that puts a request on its own host, or null to serve it here.
 * GET and HEAD move for good (301); a form post keeps its method (308).
 */
export function onItsHost(request: Request, env: HostEnv): Response | null {
  const app = appBase(env);
  if (app === env.PUBLIC_BASE_URL) return null;
  const url = new URL(request.url);
  const here = url.origin;
  if (EITHER.test(url.pathname)) return null;
  const forPeople = FOR_PEOPLE.test(url.pathname);
  let to: string | null = null;
  // The agents' keyless host serves the rest itself, OAuth discovery
  // included: there is none (see withoutSignIn).
  if (here === env.AGENT_BASE_URL) to = forPeople ? app : null;
  else if (here === env.PUBLIC_BASE_URL && forPeople) to = app;
  else if (here === app && !forPeople) {
    // The app's front door is the account page; anything else is the agents'.
    if (url.pathname === "/") return moved(`${app}/account`, 302);
    to = env.PUBLIC_BASE_URL;
  }
  if (!to) return null;
  const status = request.method === "GET" || request.method === "HEAD" ? 301 : 308;
  return moved(`${to}${url.pathname}${url.search}`, status);
}

/**
 * True where /mcp needs no sign-in and must not look as if it did: on the
 * agents' keyless host, and on a node with one person on every seat (§8.2),
 * which has no accounts. There a token is ignored and the OAuth provider is
 * left out, so discovery finds nothing and no client opens a sign-in window
 * it never needed.
 */
export const withoutSignIn = (request: Request, env: HostEnv & { ONE_HUMAN?: string }) =>
  env.ONE_HUMAN === "1" ||
  (!!env.AGENT_BASE_URL && new URL(request.url).origin === env.AGENT_BASE_URL);

const moved = (location: string, status: number) =>
  new Response(null, { status, headers: { Location: location, "Cache-Control": "no-store" } });
