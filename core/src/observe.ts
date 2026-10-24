// Every join and move already goes through Notifier.roomChanged, and every
// gated move through requestConfirmation, whichever side made it (agent,
// browser, Telegram button). Wrapping the notifier is therefore the one place
// that sees the whole negotiation, so the analytics events come from here.

import type { Analytics } from "./analytics.js";
import * as db from "./db.js";
import type { Notifier } from "./notifier.js";

/** How a party takes part: through an agent, or in person on the web page. */
async function kindOf(d1: D1Database, userId: string, roomId: string) {
  return (await db.webLinkFor(d1, userId, roomId)) ? "web" : "agent";
}

async function roomEvent(
  d1: D1Database,
  a: Analytics,
  roomId: string,
  actor: string,
  endOnly = false,
) {
  const [room, parties, history] = await Promise.all([
    db.getRoom(d1, roomId),
    db.getParticipants(d1, roomId),
    db.listMessages(d1, roomId),
  ]);
  if (!room) return;
  const [kinds, keyless] = await Promise.all([
    Promise.all(parties.map((p) => kindOf(d1, p.user_id, roomId))),
    Promise.all(parties.map((p) => db.isKeylessSeat(d1, p.user_id, roomId))),
  ]);
  const base = {
    room: roomId,
    round: room.round,
    state: room.state,
    actor_kind: kinds[parties.findIndex((p) => p.user_id === actor)] ?? "agent",
    // "agent+web": who was in the room, initiator first.
    parties: kinds.join("+"),
    // How many agents in the room came without an account: 0, 1 or 2.
    keyless_agents: keyless.filter(Boolean).length,
    internal: parties.some((p) => a.isInternal(p.user_id)),
  };

  const last = history.at(-1);
  if (endOnly) {
    // Nobody moved: the clock ran out.
  } else if (!last) a.capture(actor, "room_joined", base);
  else a.capture(actor, "move_made", { ...base, verdict: last.verdict });

  if (room.state === "agreed" || room.state === "closed" || room.state === "expired") {
    const users = new Set(parties.map((p) => p.user_id));
    a.capture(actor, "negotiation_ended", {
      ...base,
      outcome: room.state,
      moves: history.length,
      // closed by reject or cancel, or expired by time: a clean walkaway
      // reads differently from a room left to rot.
      last_verdict: last?.verdict ?? null,
      minutes: Math.round((Date.now() - Date.parse(room.created_at)) / 60_000),
      // The north star: agreements between two different accounts.
      two_accounts: users.size === 2,
    });
  }
}

export function observed(inner: Notifier, a: Analytics, d1: D1Database): Notifier {
  return {
    bindLink: (userId) => inner.bindLink(userId),
    roomEntered: (roomId, userId, inviteUrl) => inner.roomEntered(roomId, userId, inviteUrl),
    async circling(roomId) {
      await inner.circling(roomId);
      const [initiator] = await db.getParticipants(d1, roomId);
      if (initiator) {
        a.capture(initiator.user_id, "circling_detected", {
          room: roomId,
          internal: a.isInternal(initiator.user_id),
        });
      }
    },
    async limitsApart(roomId, fields) {
      await inner.limitsApart(roomId, fields);
      const [initiator] = await db.getParticipants(d1, roomId);
      if (initiator) {
        a.capture(initiator.user_id, "limits_apart", {
          room: roomId,
          fields: fields.length,
          internal: a.isInternal(initiator.user_id),
        });
      }
    },
    async roomChanged(roomId, actorUserId) {
      await inner.roomChanged(roomId, actorUserId);
      try {
        await roomEvent(d1, a, roomId, actorUserId);
      } catch (e) {
        console.error(JSON.stringify({ event: "analytics_failed", error: String(e) }));
      }
    },
    async requestConfirmation(userId, card) {
      const delivery = await inner.requestConfirmation(userId, card);
      a.capture(userId, "confirmation_requested", {
        room: card.room,
        round: card.round,
        verdict: card.verdict,
        // Not delivered means the human has yet to bind Telegram: a drop-off point.
        delivered: delivery.delivered,
      });
      return delivery;
    },
  };
}

/** negotiation_ended for a room that ran out on its own, attributed to its initiator. */
export async function captureExpired(d1: D1Database, a: Analytics, roomId: string) {
  const [initiator] = await db.getParticipants(d1, roomId);
  if (initiator) await roomEvent(d1, a, roomId, initiator.user_id, true);
}
