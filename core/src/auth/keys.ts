// Static bearer keys (PROTOCOL.md §10). Hermes and OpenClaw usually run on a
// server, as a Telegram bot: their OAuth callback listens on that server's
// loopback, which the human's browser cannot reach, so browser sign-in never
// finishes. They POST /keys once and send the key as `Authorization: Bearer`.

import { insertApiKey, userForApiKeyHash } from "../db.js";
import { apiKey, userId as newUserId } from "../ids.js";

const PREFIX = "tsk_";

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A key and the user it acts for. Without `userId` that is a new user — what
 * POST /keys does for an agent with no account; the account page passes its
 * own. The key exists only in this return value; D1 keeps its hash and last
 * four characters.
 */
export async function issueKey(
  db: D1Database,
  now: Date,
  opts: { userId?: string; label?: string | null } = {},
): Promise<{ key: string; userId: string }> {
  const key = `${PREFIX}${apiKey()}`;
  const userId = opts.userId ?? newUserId();
  await insertApiKey(db, {
    key_hash: await sha256(key),
    user_id: userId,
    created_at: now.toISOString(),
    label: opts.label || null,
    hint: key.slice(-4),
  });
  return { key, userId };
}

/** The user a key belongs to; null for anything that is not one of ours. */
export async function userForKey(db: D1Database, token: string): Promise<string | null> {
  if (!token.startsWith(PREFIX)) return null;
  return userForApiKeyHash(db, await sha256(token));
}
