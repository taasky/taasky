// The web card: the human's channel without Telegram (PROTOCOL.md §8). The
// card waits on a page of this server, and the agent hands its human the
// link. Meant for a node inside a company's perimeter, where the card must
// not travel through a third party and the node is not reachable from the
// internet.
//
//   GET  /c/<token>  the card: what the agent asks to do, and the buttons
//   POST /c/<token>  the human's answer: confirm, decline, or a counter instead.
//                    Asked for JSON (scripts/smoke.mjs), the outcome as data
//
// A link is minted per parked move and kept as a hash, like room tokens: it
// is the whole credential for one answer, and it stops working once the move
// is no longer pending.

import { sha256 } from "../auth/keys.js";
import * as db from "../db.js";
import { roomUrlFor } from "../deals.js";
import { appBase, type HostEnv } from "../hosts.js";
import { escapeHtml, htmlResponse, page } from "../html.js";
import { confirmToken } from "../ids.js";
import { cardForPending, counterInstead, resolveHumanMove } from "../moves.js";
import type { Notifier } from "../notifier.js";
import { MoveError } from "../protocol/state.js";
import { cardMessage } from "../telegram.js";

export interface ConfirmEnv extends HostEnv {
  DB: D1Database;
}

/**
 * Confirmations on the web card. Nothing is pushed: the other notices
 * (§6) have no channel here, so they go to the log, and the room page shows
 * the same when the human opens it.
 */
export function webNotifier(env: ConfirmEnv): Notifier {
  const log = (event: string, fields: Record<string, unknown>) =>
    console.log(JSON.stringify({ event, ...fields }));
  return {
    async requestConfirmation(userId, card) {
      const token = confirmToken();
      await db.insertConfirmLink(env.DB, {
        token_hash: await sha256(token),
        pending_id: card.pending_id,
        user_id: userId,
        created_at: new Date().toISOString(),
      });
      return { delivered: false, confirm_url: `${appBase(env)}/c/${token}` };
    },
    async roomChanged(roomId, actorUserId) {
      log("room_changed", { room: roomId, actor: actorUserId });
    },
    async bindLink() {
      return null;
    },
    async limitsApart(roomId, fields) {
      log("limits_apart", { room: roomId, fields });
    },
    async roomEntered(roomId, userId) {
      log("room_entered", { room: roomId, user: userId });
    },
    async circling(roomId) {
      log("circling", { room: roomId });
    },
  };
}

export async function handleConfirm(request: Request, env: ConfirmEnv): Promise<Response | null> {
  const m = /^\/c\/([a-z0-9]{26})$/.exec(new URL(request.url).pathname);
  if (!m) return null;
  if (request.method !== "GET" && request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  const link = await db.getConfirmLink(env.DB, await sha256(m[1]!));
  const pending = link && (await db.getPendingMove(env.DB, link.pending_id));
  if (!link || !pending) {
    return note(
      "Link not found",
      "This link doesn't open anything. Check that it's complete.",
      404,
    );
  }
  const roomUrl = await roomUrlFor(env.DB, appBase(env), link.user_id, pending.room_id);
  if (pending.status !== "pending") return answered(pending.status, roomUrl);
  if (request.method === "POST") {
    const json = request.headers.get("Accept")?.includes("application/json") ?? false;
    return answer(env, link, await request.formData(), roomUrl, json);
  }

  const card = await cardForPending(env.DB, pending, link.user_id, new Date());
  const them = await db.shownAs(
    env.DB,
    (await db.getParticipants(env.DB, pending.room_id)).find((p) => p.user_id !== link.user_id),
  );
  return htmlResponse(
    page("Confirm", cardHtml(cardMessage(card, roomUrl, them)), { narrow: true }),
  );
}

/** The Telegram card, as a page: the same text, its buttons as forms. */
export function cardHtml(msg: ReturnType<typeof cardMessage>): string {
  // The text is Telegram's HTML subset, already escaped where the peer wrote it.
  const text = msg.text
    .split("\n\n")
    .map((para) => `<p>${para.split("\n").join("<br>")}</p>`)
    .join("");
  const buttons = msg.reply_markup.inline_keyboard.flat().map((b) => {
    if ("url" in b)
      return `<a class="button" href="${escapeHtml(b.url)}">${escapeHtml(b.text)}</a>`;
    const [kind, , index] = b.callback_data.split(":");
    const decision = kind === "c" ? "confirm" : kind === "d" ? "decline" : "instead";
    return `<form method="post"><input type="hidden" name="decision" value="${decision}">${
      index === undefined ? "" : `<input type="hidden" name="option" value="${escapeHtml(index)}">`
    }<button${kind === "c" ? ' class="primary"' : ""}>${escapeHtml(b.text)}</button></form>`;
  });
  return `<p class="eyebrow">Taasky · your confirmation</p><div class="lede">${text}</div>
<div class="actions">${buttons.join("")}</div>
<p><small>Your agent asked for this. Nothing is sent until you answer here.</small></p>`;
}

async function answer(
  env: ConfirmEnv,
  link: db.ConfirmLink,
  form: FormData,
  roomUrl: string,
  json: boolean,
): Promise<Response> {
  const decision = String(form.get("decision") ?? "");
  const now = new Date();
  const done = (r: { status: string; reason?: string }) =>
    json ? Response.json(r) : answered(r.status, roomUrl, r.reason);
  try {
    if (decision === "confirm" || decision === "decline") {
      return done(await resolveHumanMove(env.DB, link.user_id, link.pending_id, decision, now));
    }
    if (decision === "instead") {
      const option = Number(form.get("option"));
      return done(await counterInstead(env.DB, link.user_id, link.pending_id, option, now));
    }
  } catch (e) {
    if (e instanceof MoveError) {
      return json
        ? Response.json({ error: e.message }, { status: 409 })
        : note("Not sent", e.message, 409);
    }
    throw e;
  }
  return note("Not sent", "That answer isn't one of the buttons.", 400);
}

const OUTCOME: Record<string, [string, string]> = {
  released: ["Sent", "Your agent's move went out. Your agent sees the outcome."],
  countered: ["Sent", "Your counter went out instead."],
  declined: ["Not sent", "You said no. Nothing went out, and your agent knows."],
  stale: [
    "Not sent",
    "The room moved since this card, so it no longer describes what would be sent.",
  ],
  superseded: [
    "Not sent",
    "Your agent asked for something newer. Use the latest link it gave you.",
  ],
};

function answered(status: string, roomUrl: string, reason?: string): Response {
  const [title, text] = OUTCOME[status] ?? ["Already answered", `This move is ${status}.`];
  return htmlResponse(
    page(
      title,
      `<p class="eyebrow">Taasky</p><h1>${escapeHtml(title)}</h1><p class="lede">${escapeHtml(text)}${
        reason ? ` (${escapeHtml(reason)})` : ""
      }</p><p><a class="button" href="${escapeHtml(roomUrl)}">Open the room</a></p>`,
      { narrow: true },
    ),
  );
}

function note(title: string, text: string, status: number): Response {
  return htmlResponse(
    page(
      title,
      `<p class="eyebrow">Taasky</p><h1>${escapeHtml(title)}</h1><p class="lede">${escapeHtml(text)}</p>`,
      { narrow: true },
    ),
    status,
  );
}
