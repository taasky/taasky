// The human's channel (PROTOCOL.md §8). Telegram is the v1 implementation
// (src/telegram.ts), the web card (src/web/confirm.ts) serves a node without
// it, and Slack is the second push channel.

import type { HumanGatedVerdict } from "./protocol/envelope.js";
import type { Breach } from "./protocol/limits.js";
import type { FieldType } from "./protocol/subject.js";

export interface CardField {
  field: string;
  type: FieldType;
  /** Written by whoever declared the schema — untrusted when that is the peer. */
  label: string;
  value: unknown;
  /** Where the value breaks the confirming human's own limits (§7). */
  breaches?: Breach[];
}

/**
 * What the human confirms. Rendered from typed fields of the declared schema,
 * never from the agent's summary: confirming a retelling is theatre (§8).
 */
export interface ConfirmationCard {
  pending_id: string;
  room: string;
  round: number;
  verdict: HumanGatedVerdict;
  /** The terms on the table, or null when none were ever tabled. */
  terms: {
    by: "you" | "peer";
    subject_hash: string;
    fields: CardField[];
    labels_untrusted: boolean;
    /** Whether the confirming human set limits, and whether these terms keep to them. */
    limits?: "none" | "within" | "outside";
  } | null;
  /**
   * Approve cards only: terms the human can send instead with one tap. Each
   * lists only the fields that differ from the terms on the table.
   */
  instead?: Alternative[];
}

export interface Alternative {
  fields: CardField[];
  /** As far toward their terms as the human's limits go: sending it shows that bound. */
  closest: boolean;
}

/**
 * Whether the card reached the human. Before their channel is bound it cannot:
 * the agent gets a link to hand them, and binding it delivers the card (§10).
 * On the web card nothing is pushed: the card waits under `confirm_url`, and
 * the agent hands that link to its human.
 */
export type Delivery =
  | { delivered: true }
  | { delivered: false; bind_url: string }
  | { delivered: false; confirm_url: string };

export interface Notifier {
  requestConfirmation(userId: string, card: ConfirmationCard): Promise<Delivery>;
  /**
   * `actorUserId` just joined or moved in the room: tell the other party's
   * human, if they want to hear it (§6). Never fails the move it follows.
   */
  roomChanged(roomId: string, actorUserId: string): Promise<void>;
  /**
   * The link that connects the user's human to this channel, or null when it
   * is already connected. Handed out up front, on opening, so the first
   * confirmation is not also the first time the human hears of Taasky.
   */
  bindLink(userId: string): Promise<string | null>;
  /**
   * Both sides' limits cannot be met on `fields` (§7): tell both humans,
   * without either number. Never fails the move it follows.
   */
  limitsApart(roomId: string, fields: string[]): Promise<void>;
  /**
   * `userId`'s agent just opened (with the invite to pass on) or joined a
   * room, and their human is already reachable: say so, so the first they
   * hear of it is not a confirmation. Never fails the move it follows.
   */
  roomEntered(roomId: string, userId: string, inviteUrl: string | null): Promise<void>;
  /** The room has started going in circles (isCircling): tell both humans. */
  circling(roomId: string): Promise<void>;
}

/** Local development: the card goes to the log and is answered via /dev/confirm. */
export const logNotifier: Notifier = {
  async requestConfirmation(userId, card) {
    console.log(JSON.stringify({ event: "confirmation_requested", user: userId, card }));
    return { delivered: true };
  },
  async roomChanged(roomId, actorUserId) {
    console.log(JSON.stringify({ event: "room_changed", room: roomId, actor: actorUserId }));
  },
  async bindLink() {
    return null;
  },
  async limitsApart(roomId, fields) {
    console.log(JSON.stringify({ event: "limits_apart", room: roomId, fields }));
  },
  async roomEntered(roomId, userId, inviteUrl) {
    console.log(JSON.stringify({ event: "room_entered", room: roomId, user: userId, inviteUrl }));
  },
  async circling(roomId) {
    console.log(JSON.stringify({ event: "circling", room: roomId }));
  },
};
