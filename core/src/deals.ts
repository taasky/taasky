// A person's deals in one place (docs/accounts.md): every room of every id
// that is them, whether they signed in or claimed keyless rooms. The account
// page and the bot's /deals both read this.

import * as db from "./db.js";
import { webToken } from "./ids.js";
import { roomLabel } from "./names.js";
import { asOf, type RoomState } from "./protocol/state.js";

/** How a deal stands, in a word or two: the account page and /deals say the same. */
export const STANDING: Record<RoomState, string> = {
  draft: "Waiting for them to join",
  awaiting: "Under way",
  agreed: "Agreed",
  closed: "Closed",
  expired: "Expired",
};

export interface Deal {
  room: string;
  name: string;
  state: RoomState;
  /** The other side's name, when they show it. */
  with: string | null;
  /** When the room was opened. */
  at: string;
  /** Where this person looks at it: their browser page, or the read-only view. */
  url: string;
}

/**
 * Where `userId`'s human sees the room: their own page if they answer in the
 * browser, otherwise the read-only view of what their agent negotiates.
 */
export async function roomUrlFor(
  d1: D1Database,
  baseUrl: string,
  userId: string,
  roomId: string,
): Promise<string> {
  const web = await db.webLinkFor(d1, userId, roomId);
  if (web) return `${baseUrl}/p/${web.token}`;
  const token = await db.viewLinkFor(d1, userId, roomId, {
    token: webToken(),
    created_at: new Date().toISOString(),
  });
  return `${baseUrl}/r/${token}`;
}

/** The deals of everyone in `userIds` and of the ids they claimed, newest first. */
export async function listDeals(
  d1: D1Database,
  baseUrl: string,
  userIds: readonly string[],
  limit = 50,
): Promise<Deal[]> {
  const ids = [...new Set((await Promise.all(userIds.map((u) => db.idsOf(d1, u)))).flat())];
  const rooms = await db.listRoomsForUsers(d1, ids, limit);
  // Every room's way in, looked up at once; view links only made where missing.
  const seats = rooms.map((r) => ({ user_id: r.user_id, room_id: r.id }));
  const { web, view } = await db.linksFor(d1, seats);
  const key = (l: { user_id: string; room_id: string }) => `${l.user_id} ${l.room_id}`;
  const pages = new Map(web.map((l) => [key(l), `${baseUrl}/p/${l.token}`]));
  const views = new Map(view.map((l) => [key(l), l.token]));
  const created_at = new Date().toISOString();
  const missing = seats
    .filter((s) => !pages.has(key(s)) && !views.has(key(s)))
    .map((s) => ({ ...s, token: webToken(), created_at }));
  await db.insertViewLinks(d1, missing);
  for (const l of missing) views.set(key(l), l.token);

  const now = new Date();
  return rooms.map((r, i) => {
    const k = key(seats[i]!);
    return {
      room: r.id,
      name: roomLabel(r.id),
      state: asOf(r, now).state,
      with: r.with_name,
      at: r.created_at,
      url: pages.get(k) ?? `${baseUrl}/r/${views.get(k)}`,
    };
  });
}
