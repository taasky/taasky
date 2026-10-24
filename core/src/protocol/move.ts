// What a move does to a room (PROTOCOL.md §3, §5), decided without touching
// storage. The caller loads the room, asks for a plan, and writes it only if
// the room has not changed in between.

import { CARRIES_TERMS, subjectHash, type Verdict } from "./envelope.js";
import { assertMoveAllowed, MoveError, nextState, type RoomView } from "./state.js";
import { type SubjectSchema, validateSubject } from "./subject.js";

export interface MoveParty {
  id: string;
  subject_schema: SubjectSchema;
}

export interface MoveHistoryItem {
  id: string;
  seq: number;
  from_id: string;
  verdict: string;
  subject_hash: string | null;
}

export interface MoveRequest {
  actor: string;
  verdict: Verdict;
  /** offer / counter only. */
  subject?: unknown;
  /** approve only: the hash of the terms being approved, as the actor read them. */
  subject_hash?: string;
  deadline?: string | null;
}

export interface MovePlan {
  message: {
    verdict: Verdict;
    in_reply_to: string | null;
    subject_hash: string | null;
    subject: Record<string, unknown> | null;
    deadline: string | null;
  };
  next: Omit<RoomView, "id">;
}

/** How many moves in a row without new terms count as going in circles. */
export const CIRCLE_WINDOW = 4;

/**
 * The room is going in circles: the last CIRCLE_WINDOW moves were all
 * counters or requests for detail, and none of them tabled terms that were
 * not on the table before — two sides restating their positions, or asking
 * each other the same thing. Two agents whose humans' bounds never meet do
 * this forever, and neither can say so without giving its bound away.
 * Tiny concessions (100 → 99.99) are new terms and do not count.
 */
export function isCircling<T extends MoveHistoryItem>(history: readonly T[]): boolean {
  const recent = history.slice(-CIRCLE_WINDOW);
  if (recent.length < CIRCLE_WINDOW) return false;
  if (!recent.every((m) => m.verdict === "counter" || m.verdict === "need_more_detail")) {
    return false;
  }
  const seen = new Set(history.slice(0, -CIRCLE_WINDOW).map((m) => m.subject_hash));
  return recent.every((m) => !m.subject_hash || seen.has(m.subject_hash));
}

/** The last move that put terms on the table, if any. */
export function termsOnTable<T extends MoveHistoryItem>(history: readonly T[]): T | null {
  for (let i = history.length - 1; i >= 0; i--) {
    if (CARRIES_TERMS.has(history[i]!.verdict as Verdict)) return history[i]!;
  }
  return null;
}

export async function planMove(
  room: RoomView,
  parties: readonly MoveParty[],
  history: readonly MoveHistoryItem[],
  req: MoveRequest,
  now: Date,
): Promise<MovePlan> {
  const actor = parties.find((p) => p.id === req.actor);
  if (!actor) throw new MoveError("you do not take part in this room");
  assertMoveAllowed(room, req.actor, req.verdict, now);

  const deadline = req.deadline ?? null;
  if (deadline !== null) {
    const at = Date.parse(deadline);
    if (Number.isNaN(at)) throw new MoveError("deadline must be RFC3339");
    if (at <= now.getTime()) throw new MoveError("deadline must be in the future");
  }

  const terms = termsOnTable(history);
  const last = history.at(-1) ?? null;
  const carriesTerms = CARRIES_TERMS.has(req.verdict);
  if (!carriesTerms && req.subject !== undefined) {
    throw new MoveError(`${req.verdict} carries no terms; leave subject out`);
  }
  if (req.verdict !== "approve" && req.subject_hash !== undefined) {
    throw new MoveError("subject_hash is only given with approve");
  }

  let subject: Record<string, unknown> | null = null;
  let hash: string | null = null;
  let inReplyTo: string | null = last?.id ?? null;
  let bothApproved = false;

  switch (req.verdict) {
    case "offer":
    case "counter":
      if (req.verdict === "offer" && terms) {
        throw new MoveError("terms are already on the table; answer them with counter");
      }
      if (req.verdict === "counter" && !terms) {
        throw new MoveError("nothing to counter yet; open with offer");
      }
      if (req.subject === undefined) throw new MoveError(`${req.verdict} needs a subject`);
      // A party's terms conform to the shape that party declared (§4).
      subject = validateSubject(actor.subject_schema, req.subject);
      hash = await subjectHash(subject);
      break;

    case "need_more_detail":
      if (!terms) throw new MoveError("nothing to ask about yet; open with offer");
      break;

    case "approve": {
      if (!terms) throw new MoveError("no terms on the table to approve");
      if (req.subject_hash === undefined) {
        throw new MoveError("approve must name the subject_hash of the terms it accepts");
      }
      if (req.subject_hash !== terms.subject_hash) {
        throw new MoveError("subject_hash does not match the terms on the table; re-read the room");
      }
      hash = terms.subject_hash;
      inReplyTo = terms.id;
      // Agreement is two approvals of the same terms (§5). Only approvals made
      // after those terms were tabled count — an approval of an earlier,
      // identical offer was answered by a counter in between.
      bothApproved = history.some(
        (m) =>
          m.seq > terms.seq &&
          m.verdict === "approve" &&
          m.subject_hash === hash &&
          m.from_id !== req.actor,
      );
      break;
    }

    case "reject":
    case "cancel":
      break;
  }

  return {
    message: {
      verdict: req.verdict,
      in_reply_to: inReplyTo,
      subject_hash: hash,
      subject,
      deadline,
    },
    next: nextState(room, req.verdict, {
      bothApproved,
      participants: parties.map((p) => p.id),
      deadline,
    }),
  };
}
