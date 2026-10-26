// Discovery files that are not static: the agent-skills index carries the
// skill's digest, and the skill lives in taasky-docs, so it is read from there.
// Catalogs such as integrations.sh look for these on the server's own domain.

import { sha256 } from "./auth/keys.js";
import { SKILL_URL, SKILL_VERSION } from "./skill.js";

const CORS = { "Access-Control-Allow-Origin": "*" };

/** RFC 9727: where the API lives and what describes it. */
export function apiCatalog(base: string): Response {
  const card = { href: `${base}/.well-known/mcp/server-card.json`, type: "application/json" };
  const doc = { href: "https://docs.taasky.ai", type: "text/html" };
  const body = {
    linkset: [
      { anchor: `${base}/mcp`, "service-desc": [card], "service-doc": [doc] },
      {
        anchor: `${base}/mcp/account`,
        "service-desc": [card],
        "service-doc": [
          { href: "https://docs.taasky.ai/reference/authentication", type: "text/html" },
        ],
      },
    ],
  };
  return new Response(JSON.stringify(body), {
    headers: {
      ...CORS,
      "Content-Type": 'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"',
      "Cache-Control": "public, max-age=3600",
    },
  });
}

let cached: { version: string; digest: string } | null = null;

/**
 * common-ground, which taasky-docs copies from taasky/plugin. Unversioned: it
 * changes on its own schedule, so its digest is re-read hourly. Until docs
 * serves it, the index lists taasky alone rather than failing.
 */
export const COMMON_GROUND_URL =
  "https://docs.taasky.ai/.well-known/agent-skills/common-ground/SKILL.md";
const HOUR = 3600_000;
let commonGround: { at: number; digest: string | null } | null = null;

async function commonGroundDigest(fetcher: typeof fetch, now: number): Promise<string | null> {
  if (commonGround && now - commonGround.at < HOUR) return commonGround.digest;
  let digest: string | null = null;
  try {
    const res = await fetcher(COMMON_GROUND_URL);
    if (res.ok) digest = `sha256:${await sha256(await res.text())}`;
  } catch {}
  commonGround = { at: now, digest };
  return digest;
}

/** The agent-skills discovery index (schema 0.2.0), pointing at the skills on docs.taasky.ai. */
export async function skillsIndex(
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<Response> {
  if (cached?.version !== SKILL_VERSION) {
    const res = await fetcher(SKILL_URL);
    if (!res.ok) return new Response("skill unavailable", { status: 502, headers: CORS });
    cached = { version: SKILL_VERSION, digest: `sha256:${await sha256(await res.text())}` };
  }
  const cg = await commonGroundDigest(fetcher, now);
  const body = {
    $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
    skills: [
      {
        name: "taasky",
        type: "skill-md",
        description:
          "Negotiate a meeting time, price or date with another person or their agent through Taasky; the human confirms in Telegram.",
        url: SKILL_URL,
        digest: cached.digest,
      },
      ...(cg
        ? [
            {
              name: "common-ground",
              type: "skill-md",
              description:
                "Reach a shared understanding with another person's agent, or between your own sessions, through Taasky: one list of findings, each agreed, disputed or open.",
              url: COMMON_GROUND_URL,
              digest: cg,
            },
          ]
        : []),
    ],
  };
  return Response.json(body, { headers: { ...CORS, "Cache-Control": "public, max-age=3600" } });
}

/**
 * The OpenAI plugin portal proves we own the MCP host by fetching its token
 * here: the token alone, as plain text. Until it is set, there is nothing to prove.
 */
export function openaiAppsChallenge(token: string | undefined): Response {
  if (!token) return new Response("Not found", { status: 404 });
  return new Response(token.trim(), {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}
