// Rooms run out on their own (§6): a deadline passes, nobody takes up an
// invitation, or nobody moves for a week. Reading a room already stores the
// first lazily; this sweep does all three on a schedule, so both humans hear
// the negotiation is over and the analytics see it end. Keyless rooms make
// it matter: nobody comes back to read a room its agent forgot.

import type { Analytics } from "./analytics.js";
import * as db from "./db.js";
import type { Notifier } from "./notifier.js";
import { captureExpired } from "./observe.js";

/**
 * Older than this when first swept, a room is expired quietly — no message,
 * no event. Keeps the first run, over every room ever left behind, from
 * filling chats and dashboards with news from weeks ago.
 */
const ANNOUNCE_WITHIN_MS = 24 * 3600_000;

/**
 * A room nobody has moved in for this long is over. Without it, two agents
 * whose humans' limits never meet, or that simply stopped, keep a room open
 * forever; with no deadline, nothing else would end it.
 */
export const IDLE_DAYS = 7;

/** When `room` runs out: its deadline, its invitation's end while a draft, or a week idle. */
export function dueAt(room: db.LiveRoom): number {
  const times = [room.deadline, room.state === "draft" ? room.invite_expires_at : null].flatMap(
    (t) => (t ? [Date.parse(t)] : []),
  );
  times.push(Date.parse(room.last_activity) + IDLE_DAYS * 86400_000);
  return Math.min(...times);
}

/**
 * Expires every live room past its time. `notifier` is the bare channel —
 * analytics are captured here, once per room, not once per message.
 */
export async function expireRooms(
  d1: D1Database,
  notifier: Notifier,
  a: Analytics,
  now: Date,
): Promise<{ expired: number; announced: number }> {
  let expired = 0;
  let announced = 0;
  for (const room of await db.listLiveRooms(d1)) {
    const due = dueAt(room);
    if (due > now.getTime()) continue;
    const stored = await db.expireRoom(d1, room);
    // Someone moved it first; it is theirs to report.
    if (stored.state !== "expired") continue;
    expired++;
    if (now.getTime() - due > ANNOUNCE_WITHIN_MS) continue;

    // roomChanged tells the party who is not the actor, so each side in
    // turn plays the actor for the other. A draft has one party: no actor.
    const parties = await db.getParticipants(d1, room.id);
    const actors = parties.length === 2 ? parties.map((p) => p.user_id) : [""];
    for (const actor of actors) await notifier.roomChanged(room.id, actor);
    await captureExpired(d1, a, room.id);
    announced++;
  }
  return { expired, announced };
}
