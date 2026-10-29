// Moves against stored rooms: load, plan (src/protocol/move.ts), write.
// Shared by the MCP tools and by whatever releases a human's confirmation.

import * as db from "./db.js";
import { messageId, participantId, pendingId } from "./ids.js";
import type { Alternative, ConfirmationCard, Delivery, Notifier } from "./notifier.js";
import {
  type HumanGatedVerdict,
  isHumanGated,
  subjectHash,
  type Verdict,
} from "./protocol/envelope.js";
import { type Breach, checkLimits, type Limits } from "./protocol/limits.js";
import { isCircling, planMove, termsOnTable } from "./protocol/move.js";
import { asOf, MoveError, type RoomState } from "./protocol/state.js";
import type { SubjectSchema } from "./protocol/subject.js";
import { counterWithin } from "./protocol/suggest.js";
import { isUnderstandingRoom } from "./protocol/understanding.js";

export interface LoadedRoom {
  room: db.RoomRow;
  parties: db.Participant[];
  me: db.Participant;
  peer: db.Participant | null;
  history: db.MessageRow[];
}

/** The room as `userId` sees it, with an overdue room stored as `expired` first (§6). */
export async function loadRoom(
  d1: D1Database,
  roomId: string,
  userId: string,
  now: Date,
): Promise<LoadedRoom> {
  let [room, parties, history] = await Promise.all([
    db.getRoom(d1, roomId),
    db.getParticipants(d1, roomId),
    db.listMessages(d1, roomId),
  ]);
  if (!room) throw new MoveError("no such room");
  const me = parties.find((p) => p.user_id === userId);
  if (!me) throw new MoveError("you do not take part in this room");

  if (asOf(room, now) !== room) room = await db.expireRoom(d1, room);
  return { room, parties, me, peer: parties.find((p) => p.id !== me.id) ?? null, history };
}

/** Why an invitation cannot be used: each needs a different next step. */
export const NO_INVITE = "no invitation with that code";
export const ANSWERED = "this invitation has already been answered";
export const WITHDRAWN = "the person who sent this invitation withdrew it";
export const INVITE_EXPIRED = "this invitation has expired";

/** An open invitation, or why it cannot be used. */
export async function openInvite(d1: D1Database, code: string, now: Date) {
  const room = await db.getRoomByInvite(d1, code.trim());
  if (!room) throw new MoveError(NO_INVITE);
  const parties = await db.getParticipants(d1, room.id);
  if (parties.length >= 2) throw new MoveError(ANSWERED);
  if (room.state === "closed") throw new MoveError(WITHDRAWN);
  if (
    room.state !== "draft" ||
    (room.invite_expires_at && Date.parse(room.invite_expires_at) <= now.getTime())
  ) {
    throw new MoveError(INVITE_EXPIRED);
  }
  return { room, initiator: parties[0]! };
}

/** Enters `userId` into an invited room as the peer; the initiator moves first. */
export async function joinRoom(
  d1: D1Database,
  code: string,
  userId: string,
  declared: SubjectSchema | null,
  now: Date,
  limits: Limits | null = null,
) {
  const { room, initiator } = await openInvite(d1, code, now);
  if (initiator.user_id === userId) throw new MoveError("you already take part in this room");
  // Declaring nothing mirrors the opener: the usual case, and the one that can't go wrong.
  const schema = declared ?? initiator.subject_schema;

  const me = participantId();
  await db.addParticipant(d1, {
    id: me,
    room_id: room.id,
    user_id: userId,
    role: "peer",
    subject_schema: schema,
    limits,
    joined_at: now.toISOString(),
  });
  // The initiator moves first, unless they opened with terms: then the peer answers them.
  const active = await db.activateRoom(d1, room.id, { initiator: initiator.id, peer: me });
  // Someone else took the seat between reading the invitation and now.
  if (!active) throw new MoveError(ANSWERED);
  return { room: active, me, initiator, schema };
}

/**
 * After a move: whether the room is going in circles, telling both humans the
 * moment it starts. Stateless — it fires on the move that tips it over.
 */
export async function noticeCircling(
  d1: D1Database,
  notifier: Notifier,
  roomId: string,
): Promise<boolean> {
  const history = await db.listMessages(d1, roomId);
  const circling = isCircling(history);
  if (circling && !isCircling(history.slice(0, -1))) await notifier.circling(roomId);
  return circling;
}

/**
 * An agent tuned to agree drifts toward any deal; its human's limits do not.
 * Its own terms outside them never leave the room (§7).
 */
export function assertWithinLimits(
  schema: SubjectSchema,
  limits: Limits | null,
  subject: Record<string, unknown>,
): void {
  const outside = checkLimits(schema, limits, subject);
  if (outside.length) {
    throw new MoveError(
      `these terms are outside your human's limits (${outside
        .map((b) => `${b.field}: ${b.rule}`)
        .join(", ")}); nothing was sent. Propose terms within them, or ask your human`,
    );
  }
}

/**
 * Plans and records a move for `loaded.me`. approve / reject / cancel are
 * refused unless `releasedByHuman` — only resolveHumanMove passes it (§8).
 *
 * `oneHuman`: every seat in the room is the same person (a node on their own
 * machine, ONE_HUMAN=1). Their yes to a list then stands for every seat, so
 * any seat's standing approval agrees the room, not only its author's.
 */
export interface MoveResult {
  msg: string;
  seq: number;
  verdict: Verdict;
  subject_hash: string | null;
  state: RoomState;
  round: number;
  your_turn: boolean;
}

/**
 * Whether this move waits for a human (§8). Not in a shared understanding
 * (§8.1): a list of findings commits no one, so there is nothing to confirm.
 */
export function needsHuman(parties: { subject_schema: SubjectSchema }[], verdict: Verdict) {
  return isHumanGated(verdict) && !isUnderstandingRoom(parties);
}

export async function playMove(
  d1: D1Database,
  loaded: LoadedRoom,
  req: { verdict: Verdict; subject?: unknown; subject_hash?: string; deadline?: string | null },
  now: Date,
  releasedByHuman = false,
  oneHuman = false,
): Promise<MoveResult> {
  if (needsHuman(loaded.parties, req.verdict) && !releasedByHuman) {
    throw new MoveError(`${req.verdict} needs your human's confirmation`);
  }
  const plan = await planMove(
    loaded.room,
    loaded.parties,
    loaded.history,
    { actor: loaded.me.id, ...req },
    now,
  );
  if (plan.message.subject) {
    assertWithinLimits(loaded.me.subject_schema, loaded.me.limits ?? null, plan.message.subject);
  }
  // A pick holds only until its picker moves again (pickOption records it after).
  if (loaded.me.standing_hash) await db.setStandingApproval(d1, loaded.me.id, null);
  const msg = messageId();
  const { seq } = await db.applyMove(
    d1,
    loaded.room,
    { id: msg, from_id: loaded.me.id, ts: now.toISOString(), ...plan.message },
    plan.next,
  );
  // The other side picked these terms from our options and confirmed them
  // with the same tap: their approve is due now, and with it the agreement.
  const waiting = loaded.peer;
  if (
    plan.message.verdict === "approve" &&
    plan.next.state === "awaiting" &&
    waiting?.standing_hash &&
    waiting.standing_hash === plan.message.subject_hash &&
    (oneHuman || termsOnTable(loaded.history)?.from_id === waiting.id)
  ) {
    const theirs = await loadRoom(d1, loaded.room.id, waiting.user_id, now);
    const agreed = await playMove(
      d1,
      theirs,
      { verdict: "approve", subject_hash: waiting.standing_hash },
      now,
      true,
      oneHuman,
    );
    return { ...agreed, your_turn: false };
  }
  return {
    msg,
    seq,
    verdict: plan.message.verdict,
    subject_hash: plan.message.subject_hash,
    state: plan.next.state,
    round: plan.next.round,
    your_turn: plan.next.turn === loaded.me.id,
  };
}

/**
 * The initiator's options, while they are still the question: the terms on
 * the table are the opening offer, the first of them. Null otherwise.
 */
export function openOptions(loaded: LoadedRoom): Record<string, unknown>[] | null {
  const initiator = loaded.parties.find((p) => p.role === "initiator");
  const terms = termsOnTable(loaded.history);
  if (!initiator?.options?.length || !terms || terms !== loaded.history[0]) return null;
  return terms.from_id === initiator.id ? initiator.options : null;
}

/**
 * A person picks one of the initiator's options with one tap (§8: the tap is
 * theirs). The opening offer is accepted as it stands. Any other is put on
 * the table as their counter, and confirmed by the same tap: once the
 * initiator approves it too, it is agreed with no second visit.
 */
export async function pickOption(d1: D1Database, loaded: LoadedRoom, index: number, now: Date) {
  const options = openOptions(loaded);
  const option = options?.[index];
  if (!option || loaded.me.role !== "peer") throw new MoveError("that option is no longer open");
  const terms = termsOnTable(loaded.history)!;
  const hash = await subjectHash(option);
  if (hash === terms.subject_hash) {
    return playMove(d1, loaded, { verdict: "approve", subject_hash: hash }, now, true);
  }
  const moved = await playMove(d1, loaded, { verdict: "counter", subject: option }, now);
  await db.setStandingApproval(d1, loaded.me.id, moved.subject_hash!);
  return moved;
}

/**
 * The proposer's yes to the terms they just tabled as final. Without it,
 * agreement takes one more round: the peer approves, then the proposer comes
 * back to approve their own terms. Their human confirms now instead, and the
 * peer's approve then agrees the room, as after pickOption. Parked like any
 * approve (§8); resolveHumanMove records it as a standing approval.
 */
export async function requestStandingApproval(
  d1: D1Database,
  notifier: Notifier,
  loaded: LoadedRoom,
  subjectHash: string,
  now: Date,
): Promise<{ card: ConfirmationCard; delivery: Delivery } | null> {
  const terms = termsOnTable(loaded.history);
  if (terms?.from_id !== loaded.me.id || terms.subject_hash !== subjectHash) {
    throw new MoveError("final applies only to terms you have just tabled");
  }
  // Nothing to confirm: the agent's own final stands at once. Null says so.
  if (!needsHuman(loaded.parties, "approve")) {
    await db.setStandingApproval(d1, loaded.me.id, subjectHash);
    return null;
  }
  const id = pendingId();
  await db.createPendingMove(d1, {
    id,
    room_id: loaded.room.id,
    participant_id: loaded.me.id,
    verdict: "approve",
    subject_hash: subjectHash,
    created_at: now.toISOString(),
  });
  const card = await renderCard(loaded, id, "approve");
  const delivery = await notifier.requestConfirmation(loaded.me.user_id, card);
  return { card, delivery };
}

/** Whether the terms on the table are ones `p` picked and already confirmed. */
export function pickedAndConfirmed(loaded: LoadedRoom, p: db.Participant | null): boolean {
  const terms = termsOnTable(loaded.history);
  return !!p?.standing_hash && terms?.from_id === p.id && terms.subject_hash === p.standing_hash;
}

/** Where the terms on the table fall outside `me`'s limits; null when `me` set none. */
export function outsideMyLimits(loaded: LoadedRoom): Breach[] | null {
  if (!loaded.me.limits) return null;
  const terms = termsOnTable(loaded.history);
  const author = terms && loaded.parties.find((p) => p.id === terms.from_id);
  if (!terms?.subject || !author) return [];
  return checkLimits(
    loaded.me.subject_schema,
    loaded.me.limits,
    terms.subject,
    author.subject_schema,
  );
}

/** At most this many counters on a card, so it stays a few buttons. */
const MAX_INSTEAD = 2;

/**
 * Counters `me` can send with one tap instead of accepting their terms, in
 * `me`'s schema: the closest terms inside my limits when theirs break them,
 * then my own other options that are not on the table and I have not
 * proposed before. Only while it is my turn and the terms are theirs.
 */
export async function alternativesFor(
  loaded: LoadedRoom,
): Promise<{ subject: Record<string, unknown>; closest: boolean }[]> {
  const { room, me, history } = loaded;
  const terms = termsOnTable(history);
  const author = terms && loaded.parties.find((p) => p.id === terms.from_id);
  if (
    room.state !== "awaiting" ||
    room.turn !== me.id ||
    !terms?.subject ||
    !author ||
    author.id === me.id
  ) {
    return [];
  }
  const out: { subject: Record<string, unknown>; closest: boolean; hash: string }[] = [];
  const seen = new Set(
    history.filter((m) => m.from_id === me.id || m === terms).map((m) => m.subject_hash),
  );
  const add = async (subject: Record<string, unknown>, closest: boolean) => {
    const hash = await subjectHash(subject);
    if (seen.has(hash) || out.some((a) => a.hash === hash)) return;
    out.push({ subject, closest, hash });
  };
  const closest = counterWithin(
    me.subject_schema,
    me.limits ?? null,
    terms.subject,
    author.subject_schema,
  );
  if (closest) await add(closest, true);
  for (const option of me.role === "initiator" ? (me.options ?? []) : []) await add(option, false);
  return out.slice(0, MAX_INSTEAD).map(({ subject, closest }) => ({ subject, closest }));
}

/** Only what differs from the terms on the table, in my schema's words. */
function insteadFields(
  loaded: LoadedRoom,
  subject: Record<string, unknown>,
): Alternative["fields"] {
  const terms = termsOnTable(loaded.history);
  return Object.entries(loaded.me.subject_schema)
    .filter(([field]) => subject[field] !== undefined)
    .filter(([field]) => JSON.stringify(subject[field]) !== JSON.stringify(terms?.subject?.[field]))
    .map(([field, decl]) => ({ field, type: decl.type, label: decl.label, value: subject[field] }));
}

async function renderCard(
  loaded: LoadedRoom,
  id: string,
  verdict: HumanGatedVerdict,
): Promise<ConfirmationCard> {
  const terms = termsOnTable(loaded.history);
  const author = terms && loaded.parties.find((p) => p.id === terms.from_id);
  const breaches = outsideMyLimits(loaded);
  const instead =
    verdict === "approve"
      ? (await alternativesFor(loaded)).map((a) => ({
          fields: insteadFields(loaded, a.subject),
          closest: a.closest,
        }))
      : [];
  return {
    ...(instead.length ? { instead } : {}),
    pending_id: id,
    room: loaded.room.id,
    round: loaded.room.round,
    verdict,
    terms:
      terms && author && terms.subject
        ? {
            by: author.id === loaded.me.id ? "you" : "peer",
            subject_hash: terms.subject_hash!,
            fields: Object.entries(author.subject_schema)
              .filter(([field]) => terms.subject![field] !== undefined)
              .map(([field, decl]) => ({
                field,
                type: decl.type,
                label: decl.label,
                value: terms.subject![field],
                breaches: breaches?.filter((b) => b.field === field),
              })),
            labels_untrusted: author.id !== loaded.me.id,
            limits: breaches === null ? "none" : breaches.length ? "outside" : "within",
          }
        : null,
  };
}

/**
 * approve / reject / cancel: checked now so the agent learns at once whether
 * the move is possible, but only parked — the human releases it (§8).
 */
export async function requestHumanMove(
  d1: D1Database,
  notifier: Notifier,
  loaded: LoadedRoom,
  req: { verdict: HumanGatedVerdict; subject_hash?: string },
  now: Date,
): Promise<{ card: ConfirmationCard; delivery: Delivery }> {
  await planMove(loaded.room, loaded.parties, loaded.history, { actor: loaded.me.id, ...req }, now);

  const id = pendingId();
  await db.createPendingMove(d1, {
    id,
    room_id: loaded.room.id,
    participant_id: loaded.me.id,
    verdict: req.verdict,
    subject_hash: req.subject_hash ?? null,
    created_at: now.toISOString(),
  });
  const card = await renderCard(loaded, id, req.verdict);
  const delivery = await notifier.requestConfirmation(loaded.me.user_id, card);
  return { card, delivery };
}

/**
 * One-human mode: an approve of the list this seat's person already said yes
 * to on another seat's page goes out now, with no second card. Null when it
 * still needs asking.
 */
export async function approveStanding(
  d1: D1Database,
  loaded: LoadedRoom,
  req: { verdict: HumanGatedVerdict; subject_hash?: string },
  now: Date,
  oneHuman: boolean,
): Promise<MoveResult | null> {
  if (!oneHuman || req.verdict !== "approve" || !req.subject_hash) return null;
  if (loaded.me.standing_hash !== req.subject_hash) return null;
  return playMove(
    d1,
    loaded,
    { verdict: "approve", subject_hash: req.subject_hash },
    now,
    true,
    true,
  );
}

/** The card for a move parked earlier, rendered from the room as it is now. */
export async function cardForPending(
  d1: D1Database,
  pending: db.PendingMove,
  userId: string,
  now: Date,
): Promise<ConfirmationCard> {
  const loaded = await loadRoom(d1, pending.room_id, userId, now);
  return await renderCard(loaded, pending.id, pending.verdict);
}

/**
 * The human's answer to a parked move. A confirmed move is re-planned against
 * the room as it is now: if the peer moved meanwhile, the confirmation no
 * longer describes what would be sent, so it goes stale instead of landing.
 */
export async function resolveHumanMove(
  d1: D1Database,
  userId: string,
  pendingMoveId: string,
  decision: "confirm" | "decline",
  now: Date,
  oneHuman = false,
) {
  const pending = await db.getPendingMove(d1, pendingMoveId);
  if (!pending) throw new MoveError("no such pending move");
  const loaded = await loadForPending(d1, pending, userId, now, oneHuman);
  if (pending.status !== "pending") throw new MoveError(`this move is already ${pending.status}`);

  const at = now.toISOString();
  if (decision === "decline") {
    await db.resolvePendingMove(d1, pending.id, "declined", at);
    return { status: "declined" as const };
  }

  // A yes to my own terms while the peer has not answered them yet (final):
  // it stands until the peer approves (playMove agrees the room then) or I move again.
  const terms = termsOnTable(loaded.history);
  if (
    pending.verdict === "approve" &&
    (loaded.room.state === "draft" ||
      (loaded.room.state === "awaiting" && loaded.room.turn !== loaded.me.id)) &&
    terms?.from_id === loaded.me.id &&
    terms.subject_hash === pending.subject_hash
  ) {
    await db.setStandingApproval(d1, loaded.me.id, pending.subject_hash);
    await db.resolvePendingMove(d1, pending.id, "released", at);
    const state =
      oneHuman && pending.subject_hash
        ? await oneYesForAll(d1, loaded.room.id, loaded.me.id, pending.subject_hash, now)
        : null;
    return {
      status: "released" as const,
      standing: true,
      state: state ?? loaded.room.state,
      round: loaded.room.round,
      your_turn: false,
    };
  }

  let result: Awaited<ReturnType<typeof playMove>>;
  try {
    result = await playMove(
      d1,
      loaded,
      { verdict: pending.verdict, subject_hash: pending.subject_hash ?? undefined },
      now,
      true,
      oneHuman,
    );
  } catch (e) {
    if (e instanceof MoveError) {
      await db.resolvePendingMove(d1, pending.id, "stale", at);
      return { status: "stale" as const, reason: e.message };
    }
    throw e;
  }
  await db.resolvePendingMove(d1, pending.id, "released", at);
  // Only a yes carries over: reject and cancel stay with the seat that asked.
  if (
    oneHuman &&
    pending.verdict === "approve" &&
    result.state !== "agreed" &&
    result.subject_hash
  ) {
    const state = await oneYesForAll(d1, loaded.room.id, loaded.me.id, result.subject_hash, now);
    if (state) return { status: "released" as const, ...result, state, your_turn: false };
  }
  return { status: "released" as const, ...result };
}

/**
 * The room as the seat that parked `pending` sees it. In one-human mode the
 * person may answer from any seat's page: holding a seat in the room is
 * enough, and the move is still played as the seat that asked.
 */
async function loadForPending(
  d1: D1Database,
  pending: db.PendingMove,
  userId: string,
  now: Date,
  oneHuman: boolean,
): Promise<LoadedRoom> {
  const loaded = await loadRoom(d1, pending.room_id, userId, now);
  if (loaded.me.id === pending.participant_id) return loaded;
  const owner = oneHuman && loaded.parties.find((p) => p.id === pending.participant_id);
  if (!owner) throw new MoveError("not your pending move");
  return loadRoom(d1, pending.room_id, owner.user_id, now);
}

/**
 * One-human mode: the person's yes to the list with `hash`, given on one
 * seat's page, stands for every other seat too. Each gets a standing approval,
 * so its agent's own approve goes straight through without a second card; an
 * approve of that list already parked there is released now. Returns the
 * room's state if that release moved it.
 */
async function oneYesForAll(
  d1: D1Database,
  roomId: string,
  fromId: string,
  hash: string,
  now: Date,
): Promise<RoomState | null> {
  let state: RoomState | null = null;
  for (const other of await db.getParticipants(d1, roomId)) {
    if (other.id === fromId) continue;
    await db.setStandingApproval(d1, other.id, hash);
    const parked = await db.getOpenPendingMove(d1, roomId, other.id);
    if (parked?.verdict === "approve" && parked.subject_hash === hash) {
      const released = await resolveHumanMove(d1, other.user_id, parked.id, "confirm", now, true);
      if (released.status === "released") state = released.state;
    }
  }
  return state;
}

/**
 * The human tapped one of the card's counters instead of accepting: their
 * own move, so it goes out now, and the parked approve is set aside. If the
 * room moved since the card, nothing is sent.
 */
export async function counterInstead(
  d1: D1Database,
  userId: string,
  pendingMoveId: string,
  index: number,
  now: Date,
  oneHuman = false,
) {
  const pending = await db.getPendingMove(d1, pendingMoveId);
  if (!pending) throw new MoveError("no such pending move");
  const loaded = await loadForPending(d1, pending, userId, now, oneHuman);
  if (pending.status !== "pending") throw new MoveError(`this move is already ${pending.status}`);
  if (pending.verdict !== "approve")
    throw new MoveError("only an accept can be swapped for a counter");

  const at = now.toISOString();
  const stale = async (reason: string) => {
    await db.resolvePendingMove(d1, pending.id, "stale", at);
    return { status: "stale" as const, reason };
  };
  if (termsOnTable(loaded.history)?.subject_hash !== pending.subject_hash) {
    return stale("the terms changed since the card");
  }
  const choice = (await alternativesFor(loaded))[index];
  if (!choice) return stale("that option is no longer open");

  let result: Awaited<ReturnType<typeof playMove>>;
  try {
    result = await playMove(d1, loaded, { verdict: "counter", subject: choice.subject }, now);
  } catch (e) {
    if (e instanceof MoveError) return stale(e.message);
    throw e;
  }
  await db.resolvePendingMove(d1, pending.id, "superseded", at);
  return { status: "countered" as const, ...result };
}
