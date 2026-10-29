import type { HumanGatedVerdict } from "./protocol/envelope.js";
import type { Limits } from "./protocol/limits.js";
import { MoveError, type RoomState, type RoomView } from "./protocol/state.js";
import type { SubjectSchema } from "./protocol/subject.js";

export interface Participant {
  id: string;
  room_id: string;
  user_id: string;
  role: "initiator" | "peer";
  subject_schema: SubjectSchema;
  /** Private to this party and the relay; never shown to the other side (§7). */
  limits?: Limits | null;
  /** The initiator's alternatives, opening offer first; the other side picks one with a tap. */
  options?: Record<string, unknown>[] | null;
  /**
   * Terms this party picked from the other's options, and confirmed by the
   * same tap. Played as its approve once the other side approves them too.
   */
  standing_hash?: string | null;
  /** The account whose name this party shows, fixed on entering the room (docs/accounts.md). */
  profile_id?: string | null;
  joined_at: string;
}

export interface RoomRow extends RoomView {
  invite_code: string | null;
  invite_expires_at: string | null;
  created_at: string;
}

interface RawRoom {
  id: string;
  state: string;
  round: number;
  turn: string | null;
  invite_code: string | null;
  invite_expires_at: string | null;
  deadline: string | null;
  created_at: string;
}

function toRoom(r: RawRoom): RoomRow {
  return { ...r, state: r.state as RoomState };
}

export async function createRoom(
  db: D1Database,
  room: {
    id: string;
    /** The initiator: a draft is theirs to open with terms (§5). */
    turn: string;
    invite_code: string;
    invite_expires_at: string;
    created_at: string;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO rooms (id, state, round, turn, invite_code, invite_expires_at, deadline, created_at)
       VALUES (?, 'draft', 0, ?, ?, ?, NULL, ?)`,
    )
    .bind(room.id, room.turn, room.invite_code, room.invite_expires_at, room.created_at)
    .run();
}

/**
 * Enters a party. One whose account has seen the name switch carries that
 * account into the room, so rooms entered before it never show a name.
 */
export async function addParticipant(db: D1Database, p: Participant): Promise<void> {
  await db
    .prepare(
      `INSERT INTO participants (id, room_id, user_id, role, subject_schema, limits, options, joined_at, profile_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
         (SELECT account_id FROM profiles
           WHERE account_id = COALESCE((SELECT account_id FROM user_links WHERE user_id = ?3), ?3)))`,
    )
    .bind(
      p.id,
      p.room_id,
      p.user_id,
      p.role,
      JSON.stringify(p.subject_schema),
      p.limits ? JSON.stringify(p.limits) : null,
      p.options?.length ? JSON.stringify(p.options) : null,
      p.joined_at,
    )
    .run();
}

export async function getRoom(db: D1Database, id: string): Promise<RoomRow | null> {
  const row = await db.prepare(`SELECT * FROM rooms WHERE id = ?`).bind(id).first<RawRoom>();
  return row ? toRoom(row) : null;
}

export async function getRoomByInvite(db: D1Database, code: string): Promise<RoomRow | null> {
  const row = await db
    .prepare(`SELECT * FROM rooms WHERE invite_code = ?`)
    .bind(code)
    .first<RawRoom>();
  return row ? toRoom(row) : null;
}

export async function getParticipants(db: D1Database, roomId: string): Promise<Participant[]> {
  const { results } = await db
    .prepare(`SELECT * FROM participants WHERE room_id = ? ORDER BY joined_at`)
    .bind(roomId)
    .all<
      Omit<Participant, "subject_schema" | "limits" | "options"> & {
        subject_schema: string;
        limits: string | null;
        options: string | null;
      }
    >();
  return results.map((r) => ({
    ...r,
    subject_schema: JSON.parse(r.subject_schema),
    limits: r.limits ? JSON.parse(r.limits) : null,
    options: r.options ? JSON.parse(r.options) : null,
  }));
}

/** Records the terms a party picked and confirmed, to be played as its approve later; null clears it. */
export async function setStandingApproval(
  db: D1Database,
  participantId: string,
  subjectHash: string | null,
): Promise<void> {
  await db
    .prepare(`UPDATE participants SET standing_hash = ? WHERE id = ?`)
    .bind(subjectHash, participantId)
    .run();
}

/** Rooms any of `userIds` takes part in, newest first, with the id that is in each. */
export async function listRoomsForUsers(
  db: D1Database,
  userIds: readonly string[],
  limit = 50,
): Promise<Array<RoomRow & { participant_id: string; user_id: string; with_name: string | null }>> {
  if (!userIds.length) return [];
  // with_name: the other side's name, when they show it (docs/accounts.md).
  const { results } = await db
    .prepare(
      `SELECT r.*, p.id AS participant_id, p.user_id AS user_id,
              (SELECT pr.name FROM participants o JOIN profiles pr ON pr.account_id = o.profile_id
                WHERE o.room_id = r.id AND o.id <> p.id AND pr.shown = 1) AS with_name
         FROM rooms r JOIN participants p ON p.room_id = r.id
        WHERE p.user_id IN (${marks(userIds.length)})
        ORDER BY r.created_at DESC
        LIMIT ?`,
    )
    .bind(...userIds, limit)
    .all<RawRoom & { participant_id: string; user_id: string; with_name: string | null }>();
  return results.map((r) => ({
    ...toRoom(r),
    participant_id: r.participant_id,
    user_id: r.user_id,
    with_name: r.with_name,
  }));
}

const marks = (n: number) => Array(n).fill("?").join(", ");

/** How many rooms any of `userIds` takes part in, in `state` if given. */
export async function countRoomsForUsers(
  db: D1Database,
  userIds: readonly string[],
  state?: RoomState,
): Promise<number> {
  if (!userIds.length) return 0;
  const row = await db
    .prepare(
      `SELECT COUNT(DISTINCT r.id) AS n FROM rooms r JOIN participants p ON p.room_id = r.id
        WHERE p.user_id IN (${marks(userIds.length)})${state ? " AND r.state = ?" : ""}`,
    )
    .bind(...userIds, ...(state ? [state] : []))
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Which of the ids that are `userId` (the account and the keyless ids it
 * claimed) sits in this room, in one query; null when none does.
 */
export async function seatIn(
  db: D1Database,
  roomId: string,
  userId: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT p.user_id FROM participants p LEFT JOIN user_links l ON l.user_id = p.user_id
        WHERE p.room_id = ?1 AND (p.user_id = ?2 OR l.account_id = ?2) LIMIT 1`,
    )
    .bind(roomId, userId)
    .first<{ user_id: string }>();
  return row?.user_id ?? null;
}

/** Whether none of these ids has an account yet: no sign-in with an identity, no link either way. */
export async function noAccount(db: D1Database, userIds: readonly string[]): Promise<boolean> {
  if (!userIds.length) return true;
  const m = marks(userIds.length);
  const row = await db
    .prepare(
      `SELECT EXISTS (SELECT 1 FROM user_links WHERE user_id IN (${m}) OR account_id IN (${m}))
           OR EXISTS (SELECT 1 FROM identities WHERE user_id IN (${m})) AS taken`,
    )
    .bind(...userIds, ...userIds, ...userIds)
    .first<{ taken: number }>();
  return !row?.taken;
}

/** The account a keyless id was claimed by, or the id itself (docs/accounts.md). */
export async function accountOf(db: D1Database, userId: string): Promise<string> {
  const row = await db
    .prepare("SELECT account_id FROM user_links WHERE user_id = ?")
    .bind(userId)
    .first<{ account_id: string }>();
  return row?.account_id ?? userId;
}

/** Puts `userId` on the Taasky Plus list; false when they were on it already. */
export async function joinPlusList(db: D1Database, userId: string, now: string): Promise<boolean> {
  const r = await db
    .prepare("INSERT INTO plus_list (user_id, joined_at) VALUES (?, ?) ON CONFLICT DO NOTHING")
    .bind(userId, now)
    .run();
  return r.meta.changes > 0;
}

export async function onPlusList(db: D1Database, userId: string): Promise<boolean> {
  return !!(await db.prepare("SELECT 1 FROM plus_list WHERE user_id = ?").bind(userId).first());
}

// ── The name the other side sees (docs/accounts.md) ─────────────────────────

export interface Profile {
  name: string;
  shown: boolean;
}

/** What a party shows the other side: a name, and the mark only a Google sign-in earns. */
export interface Shown {
  name: string;
  emailVerified: boolean;
}

/**
 * The account's profile, created with `name` the first time the person sees
 * the switch. From then on the rooms they enter show it.
 */
export async function profileFor(
  db: D1Database,
  accountId: string,
  name: string,
  now: string,
): Promise<Profile> {
  const row = await db
    .prepare(
      `INSERT INTO profiles (account_id, name, shown, created_at) VALUES (?, ?, 1, ?)
       ON CONFLICT (account_id) DO UPDATE SET account_id = account_id
       RETURNING name, shown`,
    )
    .bind(accountId, name, now)
    .first<{ name: string; shown: number }>();
  return { name: row!.name, shown: row!.shown === 1 };
}

export async function setProfile(db: D1Database, accountId: string, p: Profile): Promise<void> {
  await db
    .prepare("UPDATE profiles SET name = ?, shown = ? WHERE account_id = ?")
    .bind(p.name, p.shown ? 1 : 0, accountId)
    .run();
}

/** What a party shows, if anything: nothing for a room entered before the switch, or with it off. */
export async function shownAs(
  db: D1Database,
  party: Pick<Participant, "profile_id"> | null | undefined,
): Promise<Shown | null> {
  if (!party?.profile_id) return null;
  const row = await db
    .prepare(
      `SELECT name, EXISTS (SELECT 1 FROM identities
                WHERE user_id = ?1 AND provider = 'google' AND email IS NOT NULL) AS verified
         FROM profiles WHERE account_id = ?1 AND shown = 1`,
    )
    .bind(party.profile_id)
    .first<{ name: string; verified: number }>();
  return row ? { name: row.name, emailVerified: row.verified === 1 } : null;
}

/** Every id that is this person: the account first, then the keyless ids it claimed. */
export async function idsOf(db: D1Database, userId: string): Promise<string[]> {
  const { results } = await db
    .prepare(
      `WITH a AS (SELECT COALESCE((SELECT account_id FROM user_links WHERE user_id = ?1), ?1) AS id)
       SELECT id AS user_id, '' AS linked_at FROM a
       UNION ALL
       SELECT l.user_id, l.linked_at FROM user_links l, a WHERE l.account_id = a.id
       ORDER BY linked_at`,
    )
    .bind(userId)
    .all<{ user_id: string }>();
  return results.map((r) => r.user_id);
}

/** Links keyless ids to an account. An id already linked to another account is left alone. */
export async function linkUsers(
  db: D1Database,
  userIds: readonly string[],
  accountId: string,
  now: string,
): Promise<number> {
  const insert = db.prepare(
    "INSERT INTO user_links (user_id, account_id, linked_at) VALUES (?, ?, ?) ON CONFLICT (user_id) DO NOTHING",
  );
  const ids = userIds.filter((id) => id !== accountId);
  if (!ids.length) return 0;
  const results = await db.batch(ids.map((id) => insert.bind(id, accountId, now)));
  return results.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
}

/**
 * The room once the peer is in: afterJoin (§5), decided in the statement
 * itself so an opening offer that lands meanwhile still hands the peer the turn.
 */
export async function activateRoom(
  db: D1Database,
  roomId: string,
  ids: { initiator: string; peer: string },
): Promise<RoomRow | null> {
  // The invite stays single-use through openInvite's two-party check (§1). The
  // code itself is kept, so a second use reads as answered, not as a typo.
  const row = await db
    .prepare(
      `UPDATE rooms SET state = 'awaiting', turn = CASE WHEN round > 0 THEN ? ELSE ? END,
              invite_expires_at = NULL
        WHERE id = ? AND state = 'draft'
        RETURNING *`,
    )
    .bind(ids.peer, ids.initiator, roomId)
    .first<RawRoom>();
  return row ? toRoom(row) : null;
}

export interface MessageRow {
  id: string;
  seq: number;
  from_id: string;
  round: number;
  verdict: string;
  in_reply_to: string | null;
  subject_hash: string | null;
  deadline: string | null;
  ts: string;
  subject: Record<string, unknown> | null;
}

export async function listMessages(db: D1Database, roomId: string): Promise<MessageRow[]> {
  const { results } = await db
    .prepare(`SELECT * FROM messages WHERE room_id = ? ORDER BY seq`)
    .bind(roomId)
    .all<Omit<MessageRow, "subject"> & { subject: string | null }>();
  return results.map((m) => ({ ...m, subject: m.subject ? JSON.parse(m.subject) : null }));
}

/** A MoveError: losing a race is reported to the agent like any refused move. */
export class RoomChanged extends MoveError {
  constructor() {
    super("the room changed while this move was being made; re-read it and try again");
  }
}

// The condition every write below is guarded by: the room is still exactly as
// the move was planned against. D1 runs a batch as one transaction, so the
// message insert and the room update either both see it or neither does.
const ROOM_UNCHANGED = `id = ? AND state = ? AND round = ? AND turn IS ?`;

/** Records a planned move. Throws RoomChanged if another move landed first. */
export async function applyMove(
  db: D1Database,
  room: RoomView,
  move: {
    id: string;
    from_id: string;
    verdict: string;
    in_reply_to: string | null;
    subject_hash: string | null;
    subject: Record<string, unknown> | null;
    deadline: string | null;
    ts: string;
  },
  next: Omit<RoomView, "id">,
): Promise<{ seq: number }> {
  const guard = [room.id, room.state, room.round, room.turn] as const;
  const [inserted, updated] = await db.batch<{ seq: number }>([
    db
      .prepare(
        `INSERT INTO messages (id, room_id, seq, from_id, round, verdict, in_reply_to,
                               subject_hash, deadline, ts, subject)
         SELECT ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE room_id = ?),
                ?, ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM rooms WHERE ${ROOM_UNCHANGED})
         RETURNING seq`,
      )
      .bind(
        move.id,
        room.id,
        room.id,
        move.from_id,
        next.round,
        move.verdict,
        move.in_reply_to,
        move.subject_hash,
        move.deadline,
        move.ts,
        move.subject ? JSON.stringify(move.subject) : null,
        ...guard,
      ),
    db
      .prepare(
        `UPDATE rooms SET state = ?, round = ?, turn = ?, deadline = ?
          WHERE ${ROOM_UNCHANGED}`,
      )
      .bind(next.state, next.round, next.turn, next.deadline, ...guard),
  ]);
  const seq = inserted?.results[0]?.seq;
  if (seq === undefined || updated?.meta.changes !== 1) throw new RoomChanged();
  return { seq };
}

/** A live room and when anything last happened in it: a move, a join, or its opening. */
export type LiveRoom = RoomRow & { last_activity: string };

/** Every live room, for the expiry sweep. */
export async function listLiveRooms(db: D1Database): Promise<LiveRoom[]> {
  const { results } = await db
    .prepare(
      `SELECT r.*, COALESCE(
                (SELECT MAX(ts) FROM messages m WHERE m.room_id = r.id),
                (SELECT MAX(joined_at) FROM participants p WHERE p.room_id = r.id),
                r.created_at) AS last_activity
         FROM rooms r
        WHERE r.state IN ('draft', 'awaiting')
        ORDER BY r.created_at
        LIMIT 500`,
    )
    .all<RawRoom & { last_activity: string }>();
  return results.map((r) => ({ ...toRoom(r), last_activity: r.last_activity }));
}

/** Moves an overdue live room to `expired` (§6). Returns the room as stored afterwards. */
export async function expireRoom(db: D1Database, room: RoomRow): Promise<RoomRow> {
  const row = await db
    .prepare(`UPDATE rooms SET state = 'expired', turn = NULL WHERE ${ROOM_UNCHANGED} RETURNING *`)
    .bind(room.id, room.state, room.round, room.turn)
    .first<RawRoom>();
  // No row: something else moved the room first; report it as it now stands.
  return row ? toRoom(row) : (await getRoom(db, room.id))!;
}

export type PendingStatus = "pending" | "released" | "declined" | "stale" | "superseded";

export interface PendingMove {
  id: string;
  room_id: string;
  participant_id: string;
  verdict: HumanGatedVerdict;
  subject_hash: string | null;
  status: PendingStatus;
  created_at: string;
  resolved_at: string | null;
}

/**
 * Parks a move for its human. One open request per party per room: a newer
 * one replaces the older, since the agent has changed its mind.
 */
export async function createPendingMove(
  db: D1Database,
  p: Omit<PendingMove, "status" | "resolved_at">,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `UPDATE pending_moves SET status = 'superseded', resolved_at = ?
          WHERE room_id = ? AND participant_id = ? AND status = 'pending'`,
      )
      .bind(p.created_at, p.room_id, p.participant_id),
    db
      .prepare(
        `INSERT INTO pending_moves (id, room_id, participant_id, verdict, subject_hash,
                                    status, created_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL)`,
      )
      .bind(p.id, p.room_id, p.participant_id, p.verdict, p.subject_hash, p.created_at),
  ]);
}

export async function getPendingMove(db: D1Database, id: string): Promise<PendingMove | null> {
  return db.prepare(`SELECT * FROM pending_moves WHERE id = ?`).bind(id).first<PendingMove>();
}

export async function getOpenPendingMove(
  db: D1Database,
  roomId: string,
  participantId: string,
): Promise<PendingMove | null> {
  return db
    .prepare(
      `SELECT * FROM pending_moves
        WHERE room_id = ? AND participant_id = ? AND status = 'pending'`,
    )
    .bind(roomId, participantId)
    .first<PendingMove>();
}

/** The oldest move still waiting for a human in the room, from any seat (one-human mode). */
export async function getOpenPendingMoveInRoom(
  db: D1Database,
  roomId: string,
): Promise<PendingMove | null> {
  return db
    .prepare(
      `SELECT * FROM pending_moves
        WHERE room_id = ? AND status = 'pending'
        ORDER BY created_at, id LIMIT 1`,
    )
    .bind(roomId)
    .first<PendingMove>();
}

/** The party's latest pending move that its human has already answered, if any. */
export async function lastResolvedPendingMove(
  db: D1Database,
  roomId: string,
  participantId: string,
): Promise<PendingMove | null> {
  return db
    .prepare(
      `SELECT * FROM pending_moves
        WHERE room_id = ? AND participant_id = ? AND status != 'pending'
        ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(roomId, participantId)
    .first<PendingMove>();
}

/** Closes a pending move. False if it was no longer pending — someone got there first. */
export async function resolvePendingMove(
  db: D1Database,
  id: string,
  status: Exclude<PendingStatus, "pending">,
  at: string,
): Promise<boolean> {
  const r = await db
    .prepare(
      `UPDATE pending_moves SET status = ?, resolved_at = ? WHERE id = ? AND status = 'pending'`,
    )
    .bind(status, at, id)
    .run();
  return r.meta.changes === 1;
}

/**
 * The Taasky user behind an upstream identity, created on first sign-in. An
 * existing identity keeps its user id and only refreshes email and name, so two
 * first sign-ins racing settle on whichever user id landed.
 */
export async function userForIdentity(
  db: D1Database,
  identity: { provider: string; subject: string; email: string | null; name: string | null },
  newUserId: string,
  now: string,
): Promise<string> {
  const row = await db
    .prepare(
      `INSERT INTO identities (provider, subject, user_id, email, name, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (provider, subject) DO UPDATE SET email = excluded.email, name = excluded.name
       RETURNING user_id`,
    )
    .bind(identity.provider, identity.subject, newUserId, identity.email, identity.name, now)
    .first<{ user_id: string }>();
  return row!.user_id;
}

/** Open pending moves of every room `userId` takes part in, oldest first. */
export async function listOpenPendingForUser(
  db: D1Database,
  userId: string,
): Promise<PendingMove[]> {
  const { results } = await db
    .prepare(
      `SELECT pm.* FROM pending_moves pm
         JOIN participants p ON p.id = pm.participant_id
        WHERE p.user_id = ? AND pm.status = 'pending'
        ORDER BY pm.created_at`,
    )
    .bind(userId)
    .all<PendingMove>();
  return results;
}

/** The user who must answer a pending move. */
export async function ownerOfPendingMove(db: D1Database, id: string): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT p.user_id FROM pending_moves pm
         JOIN participants p ON p.id = pm.participant_id
        WHERE pm.id = ?`,
    )
    .bind(id)
    .first<{ user_id: string }>();
  return row?.user_id ?? null;
}

export interface Channel {
  user_id: string;
  kind: "telegram";
  address: string;
  created_at: string;
}

export async function getChannel(db: D1Database, userId: string): Promise<Channel | null> {
  return db.prepare("SELECT * FROM channels WHERE user_id = ?").bind(userId).first<Channel>();
}

/** Whether any Taasky account already sends its confirmations to this chat. */
export async function chatConnected(
  db: D1Database,
  kind: string,
  address: string,
): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS one FROM channels WHERE kind = ? AND address = ? LIMIT 1")
    .bind(kind, address)
    .first<{ one: number }>();
  return row !== null;
}

/** Binds a channel unless the user already has one. False if they did. */
export async function bindChannel(db: D1Database, c: Channel): Promise<boolean> {
  const r = await db
    .prepare(
      `INSERT INTO channels (user_id, kind, address, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id) DO NOTHING`,
    )
    .bind(c.user_id, c.kind, c.address, c.created_at)
    .run();
  return r.meta.changes === 1;
}

/** The user's unexpired bind code, or a new one. */
export async function bindCodeFor(
  db: D1Database,
  userId: string,
  fresh: { code: string; expires_at: string },
  now: string,
): Promise<string> {
  const existing = await db
    .prepare("SELECT code FROM bind_codes WHERE user_id = ? AND expires_at > ?")
    .bind(userId, now)
    .first<{ code: string }>();
  if (existing) return existing.code;
  await db
    .prepare("INSERT INTO bind_codes (code, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(fresh.code, userId, fresh.expires_at)
    .run();
  return fresh.code;
}

/** Spends a bind code: the user it was for, or null if unknown, used or expired. */
export async function takeBindCode(
  db: D1Database,
  code: string,
  now: string,
): Promise<string | null> {
  const row = await db
    .prepare("DELETE FROM bind_codes WHERE code = ? RETURNING user_id, expires_at")
    .bind(code)
    .first<{ user_id: string; expires_at: string }>();
  return row && row.expires_at > now ? row.user_id : null;
}

export interface WebLink {
  token: string;
  user_id: string;
  room_id: string;
  created_at: string;
}

export async function insertWebLink(db: D1Database, link: WebLink): Promise<void> {
  await db
    .prepare("INSERT INTO web_links (token, user_id, room_id, created_at) VALUES (?, ?, ?, ?)")
    .bind(link.token, link.user_id, link.room_id, link.created_at)
    .run();
}

export async function getWebLink(db: D1Database, token: string): Promise<WebLink | null> {
  return db.prepare("SELECT * FROM web_links WHERE token = ?").bind(token).first<WebLink>();
}

/** The browser link of a party who answers without an agent; null for agent users. */
/** Every web link and view link of these (user, room) pairs, in two queries. */
export async function linksFor(
  db: D1Database,
  pairs: ReadonlyArray<{ user_id: string; room_id: string }>,
): Promise<{ web: WebLink[]; view: WebLink[] }> {
  if (!pairs.length) return { web: [], view: [] };
  const users = [...new Set(pairs.map((p) => p.user_id))];
  const rooms = [...new Set(pairs.map((p) => p.room_id))];
  const q = (table: string) =>
    db
      .prepare(
        `SELECT * FROM ${table} WHERE user_id IN (${marks(users.length)}) AND room_id IN (${marks(rooms.length)})`,
      )
      .bind(...users, ...rooms)
      .all<WebLink>();
  const [web, view] = await Promise.all([q("web_links"), q("view_links")]);
  return { web: web.results, view: view.results };
}

/** Creates view links in one batch; an existing one for the same (user, room) is kept. */
export async function insertViewLinks(db: D1Database, links: readonly WebLink[]): Promise<void> {
  if (!links.length) return;
  const insert = db.prepare(
    `INSERT INTO view_links (token, user_id, room_id, created_at)
     SELECT ?1, ?2, ?3, ?4 WHERE NOT EXISTS (SELECT 1 FROM view_links WHERE user_id = ?2 AND room_id = ?3)`,
  );
  await db.batch(links.map((l) => insert.bind(l.token, l.user_id, l.room_id, l.created_at)));
}

export async function webLinkFor(
  db: D1Database,
  userId: string,
  roomId: string,
): Promise<WebLink | null> {
  return db
    .prepare("SELECT * FROM web_links WHERE user_id = ? AND room_id = ?")
    .bind(userId, roomId)
    .first<WebLink>();
}

export interface RoomToken {
  token_hash: string;
  user_id: string;
  room_id: string;
  created_at: string;
}

export async function insertRoomToken(db: D1Database, t: RoomToken): Promise<void> {
  await db
    .prepare(
      "INSERT INTO room_tokens (token_hash, user_id, room_id, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind(t.token_hash, t.user_id, t.room_id, t.created_at)
    .run();
}

export async function getRoomToken(db: D1Database, tokenHash: string): Promise<RoomToken | null> {
  return db
    .prepare("SELECT * FROM room_tokens WHERE token_hash = ?")
    .bind(tokenHash)
    .first<RoomToken>();
}

/** Whether `userId` holds its seat in the room through a room token (a keyless agent). */
export async function isKeylessSeat(
  db: D1Database,
  userId: string,
  roomId: string,
): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 FROM room_tokens WHERE user_id = ? AND room_id = ? LIMIT 1")
    .bind(userId, roomId)
    .first();
  return row !== null;
}

/** The read-only link of `userId`'s view of a room, created on first use. */
export async function viewLinkFor(
  db: D1Database,
  userId: string,
  roomId: string,
  fresh: { token: string; created_at: string },
): Promise<string> {
  await db
    .prepare(
      `INSERT INTO view_links (token, user_id, room_id, created_at)
       SELECT ?, ?, ?, ? WHERE NOT EXISTS
         (SELECT 1 FROM view_links WHERE user_id = ? AND room_id = ?)`,
    )
    .bind(fresh.token, userId, roomId, fresh.created_at, userId, roomId)
    .run();
  const row = await db
    .prepare("SELECT token FROM view_links WHERE user_id = ? AND room_id = ?")
    .bind(userId, roomId)
    .first<{ token: string }>();
  return row!.token;
}

export async function getViewLink(db: D1Database, token: string): Promise<WebLink | null> {
  return db.prepare("SELECT * FROM view_links WHERE token = ?").bind(token).first<WebLink>();
}

export interface ApiKeyRow {
  key_hash: string;
  user_id: string;
  created_at: string;
  label: string | null;
  hint: string | null;
}

export async function insertApiKey(db: D1Database, row: ApiKeyRow): Promise<void> {
  await db
    .prepare(
      "INSERT INTO api_keys (key_hash, user_id, created_at, label, hint) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(row.key_hash, row.user_id, row.created_at, row.label, row.hint)
    .run();
}

export async function listApiKeys(db: D1Database, userId: string): Promise<ApiKeyRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM api_keys WHERE user_id = ? ORDER BY created_at")
    .bind(userId)
    .all<ApiKeyRow>();
  return results;
}

/** Revokes one of the user's keys. False if it was not theirs or is gone. */
export async function deleteApiKey(
  db: D1Database,
  userId: string,
  keyHash: string,
): Promise<boolean> {
  const r = await db
    .prepare("DELETE FROM api_keys WHERE key_hash = ? AND user_id = ?")
    .bind(keyHash, userId)
    .run();
  return r.meta.changes === 1;
}

export async function userForApiKeyHash(db: D1Database, keyHash: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT user_id FROM api_keys WHERE key_hash = ?")
    .bind(keyHash)
    .first<{ user_id: string }>();
  return row?.user_id ?? null;
}

/** Every user whose confirmations go to this Telegram chat, oldest first. */
export async function usersForTelegramChat(db: D1Database, chatId: string): Promise<Channel[]> {
  const { results } = await db
    .prepare("SELECT * FROM channels WHERE kind = 'telegram' AND address = ? ORDER BY created_at")
    .bind(chatId)
    .all<Channel>();
  return results;
}

/** The sign-ins attached to a user: which providers, and the email each vouched for. */
export async function identitiesFor(
  db: D1Database,
  userId: string,
): Promise<{ provider: string; email: string | null; name: string | null }[]> {
  const { results } = await db
    .prepare("SELECT provider, email, name FROM identities WHERE user_id = ? ORDER BY created_at")
    .bind(userId)
    .all<{ provider: string; email: string | null; name: string | null }>();
  return results;
}

export async function insertLoginCode(
  db: D1Database,
  row: { code: string; user_id: string; expires_at: string },
): Promise<void> {
  await db
    .prepare("INSERT INTO login_codes (code, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(row.code, row.user_id, row.expires_at)
    .run();
}

/** Spends a sign-in code: the user it was for, or null if unknown, used or expired. */
export async function takeLoginCode(
  db: D1Database,
  code: string,
  now: string,
): Promise<string | null> {
  const row = await db
    .prepare("DELETE FROM login_codes WHERE code = ? RETURNING user_id, expires_at")
    .bind(code)
    .first<{ user_id: string; expires_at: string }>();
  return row && row.expires_at > now ? row.user_id : null;
}

export async function insertSession(
  db: D1Database,
  row: { token_hash: string; user_id: string; created_at: string; expires_at: string },
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    )
    .bind(row.token_hash, row.user_id, row.created_at, row.expires_at)
    .run();
}

export async function userForSession(
  db: D1Database,
  tokenHash: string,
  now: string,
): Promise<string | null> {
  const row = await db
    .prepare("SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?")
    .bind(tokenHash, now)
    .first<{ user_id: string }>();
  return row?.user_id ?? null;
}

export async function deleteSession(db: D1Database, tokenHash: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
}

/**
 * Changes whenever the room does: any move adds a message, and expiry or
 * agreement changes the state. The waiting page and negotiation_read's wait poll it — cheaper than
 * reloading the page to find nothing new.
 */
export async function roomVersion(d1: D1Database, roomId: string): Promise<string> {
  const row = await d1
    .prepare(
      `SELECT r.state, (SELECT COUNT(*) FROM messages m WHERE m.room_id = r.id) AS n,
              (SELECT group_concat(id) FROM pending_moves p
                WHERE p.room_id = r.id AND p.status = 'pending') AS asks
         FROM rooms r WHERE r.id = ?`,
    )
    .bind(roomId)
    .first<{ state: string; n: number; asks: string | null }>();
  // A parked move changes the page too: its card appears, then goes.
  return row ? `${row.state}:${row.n}:${row.asks ?? ""}` : "gone";
}
