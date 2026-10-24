// PROTOCOL.md §5. Terminal states are terminal; a new negotiation is a new room.

import { CONTINUING, type Verdict } from "./envelope.js";

export type RoomState = "draft" | "awaiting" | "agreed" | "closed" | "expired";

export class MoveError extends Error {}

export interface RoomView {
  id: string;
  state: RoomState;
  round: number;
  turn: string | null;
  deadline: string | null;
}

export function isTerminal(state: RoomState): boolean {
  return state === "agreed" || state === "closed" || state === "expired";
}

/** A live room whose deadline has passed is expired, whether or not it is stored as such yet (§6). */
export function isOverdue(room: RoomView, now: Date): boolean {
  return (
    !isTerminal(room.state) && room.deadline !== null && Date.parse(room.deadline) <= now.getTime()
  );
}

/** The room as it stands at `now`: an overdue room reads as expired (§6). */
export function asOf<R extends RoomView>(room: R, now: Date): R {
  return isOverdue(room, now) ? { ...room, state: "expired", turn: null } : room;
}

/**
 * Whether `actor` may play `verdict` right now. Rejects rather than repairs —
 * the caller surfaces the reason to the agent, which surfaces it to its human.
 */
export function assertMoveAllowed(
  room: RoomView,
  actor: string,
  verdict: Verdict,
  now: Date,
): void {
  if (isTerminal(room.state)) {
    throw new MoveError(`room is ${room.state} and accepts no further moves`);
  }
  // A draft is the initiator's alone: they may table opening terms for the
  // invitation to carry, or withdraw it. Everything else waits for the peer.
  if (room.state === "draft") {
    if (verdict === "cancel") return;
    if (verdict !== "offer" || room.turn !== actor) throw new MoveError("peer has not joined yet");
  }
  if (room.turn !== actor && verdict !== "cancel") {
    throw new MoveError("not your turn");
  }
  if (isOverdue(room, now)) {
    throw new MoveError("deadline has passed; the room is expired");
  }
}

/**
 * The room after a move. `approve` alone is not agreement: both sides must
 * approve the same terms, which the caller checks by subject_hash (§3).
 *
 * `participants` holds both parties' ids. RoomView does not carry them, so the
 * caller supplies them — without that the turn cannot be passed on.
 *
 * `deadline` is the mover's; a live room takes it over, replacing the last one.
 */
export function nextState(
  room: RoomView,
  verdict: Verdict,
  opts: { bothApproved: boolean; participants: readonly string[]; deadline: string | null },
): Omit<RoomView, "id"> {
  if (verdict === "reject" || verdict === "cancel") {
    return { state: "closed", round: room.round, turn: null, deadline: room.deadline };
  }
  const { deadline } = opts;
  // The opening offer of a draft: the turn is the peer's, who is not here yet.
  if (room.state === "draft" && verdict === "offer") {
    return { state: "draft", round: room.round + 1, turn: null, deadline };
  }
  if (verdict === "approve") {
    return opts.bothApproved
      ? { state: "agreed", round: room.round, turn: null, deadline }
      : {
          state: "awaiting",
          round: room.round,
          turn: otherThan(opts.participants, room.turn),
          deadline,
        };
  }
  if (CONTINUING.has(verdict)) {
    return {
      state: "awaiting",
      round: room.round + 1,
      turn: otherThan(opts.participants, room.turn),
      deadline,
    };
  }
  throw new MoveError(`unhandled verdict ${verdict}`);
}

/**
 * The room once the peer joins (§5). The initiator moves first: they opened
 * the room, they state terms. If they already did, in the draft, the peer
 * answers them.
 */
export function afterJoin(
  room: RoomView,
  ids: { initiator: string; peer: string },
): Omit<RoomView, "id"> {
  if (room.state !== "draft") throw new MoveError(`room is ${room.state}, not waiting for a peer`);
  return {
    state: "awaiting",
    round: room.round,
    turn: room.round > 0 ? ids.peer : ids.initiator,
    deadline: room.deadline,
  };
}

// Two parties per room in v1 (PROTOCOL.md §1 non-goals), so "the other one"
// is well defined. A live room with a null turn is one nobody can move in, so
// refuse the move rather than write that state.
function otherThan(participants: readonly string[], current: string | null): string {
  if (participants.length !== 2 || current === null || !participants.includes(current)) {
    throw new MoveError("room does not have two parties with a defined turn");
  }
  return participants.find((p) => p !== current)!;
}
