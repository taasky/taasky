// The invitation and room pages: the way into a negotiation for a person who
// has no agent (PROTOCOL.md §10). The invited side opens the link, presses one
// button and negotiates in the browser. No account, and no agent is needed on
// that side.
//
//   GET  /i/<code>   what the invitation is about; answer here or hand it to an agent.
//                    In the browser that already answered it: → /p/<token>
//                    Asked for JSON or Markdown: the same, for an agent to join with
//   POST /i/<code>   join as a browser party → /p/<token>
//   GET  /p/<token>  that party's view of the room
//   POST /p/<token>  their move
//   GET  /r/<token>  the room for the human behind an agent: their human_url,
//                    and where Telegram's "Open the negotiation" leads. Read-only,
//                    except for a move their agent parked: its card waits on top
//   POST /r/<token>  their answer to that card: confirm, decline, or a counter
//                    instead. Asked for JSON (scripts/smoke.mjs), the outcome as data
//   GET  /p/<token>/calendar.ics, /r/<token>/calendar.ics
//                    the agreed deal as a calendar event (calendar.ts)
//
// The person makes their own moves on /p, so approve / reject / cancel are
// released directly: the human gate (§8) exists to keep an agent from deciding
// alone, and no agent is involved. On /r the agent decided, so the person
// confirms here (or in Telegram) before anything is sent.

import { readCookie } from "../account/session.js";
import { agreedEvent, type CalendarEvent, googleCalendarUrl, icsFile } from "../calendar.js";
import * as db from "../db.js";
import { formatDate, formatMoney } from "../format.js";
import { appBase, type HostEnv } from "../hosts.js";
import { duo, escapeHtml, htmlResponse, page, plate } from "../html.js";
import { userId as newUserId, webToken } from "../ids.js";
import {
  ANSWERED,
  cardForPending,
  counterInstead,
  INVITE_EXPIRED,
  joinRoom,
  type LoadedRoom,
  loadRoom,
  NO_INVITE,
  noticeCircling,
  openInvite,
  openOptions,
  pickedAndConfirmed,
  pickOption,
  playMove,
  resolveHumanMove,
  WITHDRAWN,
} from "../moves.js";
import { roomLabel, roomName } from "../names.js";
import type { Notifier } from "../notifier.js";
import type { Verdict } from "../protocol/envelope.js";
import { termsOnTable } from "../protocol/move.js";
import { isTerminal, MoveError } from "../protocol/state.js";
import { type FieldType, SubjectError, type SubjectSchema } from "../protocol/subject.js";
import { replayPace, replayStory } from "../replay.js";
import { cardMessage, findingCounts } from "../telegram.js";
import {
  agentInvite,
  agentInviteMarkdown,
  type InviteFormat,
  inviteFormat,
} from "./agent-invite.js";
import { cardHtml } from "./card.js";
import { parseFields, renderFields, TIMERANGE_SCRIPT } from "./form.js";

export interface WebDeps extends HostEnv {
  DB: D1Database;
  notifier: Notifier;
  /** Telegram binding link, when the bot is configured. */
  bindUrl?: (userId: string) => Promise<string>;
}

export async function handleWeb(request: Request, deps: WebDeps): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  const invite = /^\/i\/([a-z0-9]{4,32})$/.exec(pathname);
  if (invite) {
    return request.method === "POST"
      ? acceptInvite(deps, request, invite[1]!)
      : showInvite(deps, request, invite[1]!);
  }
  const personal = /^\/p\/([a-z0-9]{26})(\/v|\/calendar\.ics)?$/.exec(pathname);
  if (personal) {
    const link = await db.getWebLink(deps.DB, personal[1]!);
    if (!link)
      return message(
        "Link not found",
        "This link doesn't open anything. Check that it's complete.",
        404,
      );
    if (personal[2] === "/calendar.ics") return calendarFile(deps, link, "p");
    if (personal[2]) return Response.json({ v: await roomVersion(deps.DB, link.room_id) });
    return request.method === "POST"
      ? move(deps, link, await request.formData())
      : showRoom(deps, link);
  }
  const view = /^\/r\/([a-z0-9]{26})(\/v|\/calendar\.ics)?$/.exec(pathname);
  if (view) {
    const answering = request.method === "POST" && !view[2];
    if (request.method !== "GET" && !answering) {
      return new Response("Method not allowed", { status: 405 });
    }
    const link = await db.getViewLink(deps.DB, view[1]!);
    if (!link)
      return message(
        "Link not found",
        "This link doesn't open anything. Check that it's complete.",
        404,
      );
    if (view[2] === "/calendar.ics") return calendarFile(deps, link, "r");
    if (view[2]) return Response.json({ v: await roomVersion(deps.DB, link.room_id) });
    if (answering) return answerCard(deps, link, request);
    return showRoom(deps, link, undefined, undefined, true);
  }
  return null;
}

/** The agreed deal as `link`'s holder sees it in their calendar; null until agreed or without a when. */
async function eventFor(
  deps: WebDeps,
  link: db.WebLink,
  kind: "p" | "r",
): Promise<CalendarEvent | null> {
  const loaded = await loadRoom(deps.DB, link.room_id, link.user_id, new Date());
  return agreedEvent({
    roomId: loaded.room.id,
    state: loaded.room.state,
    history: loaded.history,
    parties: loaded.parties,
    them: await db.shownAs(deps.DB, loaded.peer),
    url: `${appBase(deps)}/${kind}/${link.token}`,
  });
}

async function calendarFile(deps: WebDeps, link: db.WebLink, kind: "p" | "r"): Promise<Response> {
  const event = await eventFor(deps, link, kind);
  if (!event) return message("No calendar event", "This deal has no agreed time to add.", 404);
  const slug = roomName(link.room_id).name.toLowerCase().replace(/\s+/g, "-");
  return new Response(icsFile(event, new Date()), {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="taasky-${slug}.ics"`,
      "Cache-Control": "no-store",
    },
  });
}

/** Google, or the .ics that Apple Calendar and Outlook open. */
function calendarBlock(event: CalendarEvent, icsPath: string): string {
  return `<section class="calendar" id="calendar">
  <p class="eyebrow quiet" style="margin:0">Add it to your calendar</p>
  <div class="calendar-links">
    <a class="button inline" href="${escapeHtml(googleCalendarUrl(event))}" target="_blank" rel="noopener">Google Calendar</a>
    <a class="button inline" href="${escapeHtml(icsPath)}">Apple or Outlook</a>
  </div>
</section>`;
}

/** After a deal, for the person who answered in the browser: their own agent could do this. */
const GET_TAASKY = `<div class="side-note after">
  <p class="eyebrow quiet" style="margin:0">Your own agent</p>
  <p>Want your agent to settle things like this for you? Taasky works with Claude, Hermes, OpenClaw and any agent that speaks MCP.</p>
  <a class="button inline" href="https://taasky.ai/?utm_source=room&amp;utm_medium=agreed">Get Taasky <span class="arrow">&rarr;</span></a>
</div>`;

/**
 * Changes whenever the room does: any move adds a message, and expiry or
 * agreement changes the state. The waiting page polls it — cheaper than
 * reloading the page to find nothing new.
 */
async function roomVersion(d1: D1Database, roomId: string): Promise<string> {
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

/**
 * Keeps an open room page current without reloading it. While the room is
 * open (data-wait on .split) it checks /v every 2s; when the room has moved it
 * fetches the page again and swaps in only what changed, so the light passes
 * between the spheres, a changed term lights up, a new move slides into the
 * list and the seal is pressed — all in place. The person's own moves are
 * sent the same way. Without JavaScript the forms post and the page reloads
 * as before.
 */
const LIVE_SCRIPT = `<script>
(() => {
  const split = () => document.querySelector(".split");
  const replay = (el, cls) => { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); };
  const later = (ms, fn) => setTimeout(fn, matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : ms);
  // The beat of one update: old text leaves, the turn passes along the
  // ribbons, and what arrived (terms, the new move) lands as it is caught.
  const LEAVE = 240, CATCH = 900, LAND = 700;

  function patchDuo(o, n) {
    const from = o.dataset.live, to = n.dataset.live;
    const op = [...o.querySelectorAll(".party")], np = [...n.querySelectorAll(".party")];
    const settle = () => {
      o.className = n.className;
      o.style.cssText = n.style.cssText;
      o.dataset.live = to;
      op.forEach((p, i) => { p.className = np[i].className; });
      o.querySelector(".status").textContent = n.querySelector(".status").textContent;
    };
    if ((from !== "you" && from !== "them") || from === to) return settle();
    // The mover lets go at once; the other side lights only when the comet
    // reaches it, and flares as it catches the turn.
    const mover = op.find((p) => p.classList.contains(from));
    mover.classList.replace("live", "rest");
    o.dataset.live = "pass";
    o.dataset.pass = from === "you" ? "toThem" : "toYou";
    replay(o, "passing");
    later(CATCH, () => {
      settle();
      for (const p of op) if (p.classList.contains("live") && !o.classList.contains("agreed")) replay(p, "caught");
    });
  }

  function patchTerms(o, n) {
    const facts = o.querySelector(".facts"), next = n.querySelector(".facts");
    if (!facts || !next || o.classList.contains("sealed") || n.classList.contains("sealed")) return o.replaceWith(n);
    const head = o.querySelector(".terms-head");
    if (!head.isEqualNode(n.querySelector(".terms-head"))) head.replaceWith(n.querySelector(".terms-head"));
    const old = new Map([...facts.children].map((d) => [d.querySelector("dt").textContent, d]));
    let changed = false;
    for (const row of [...next.children]) {
      const label = row.querySelector("dt").textContent, was = old.get(label);
      old.delete(label);
      if (!was) { facts.append(row); replay(row.querySelector("dd"), "changed"); changed = true; continue; }
      const dd = was.querySelector("dd"), nd = row.querySelector("dd");
      if (dd.innerHTML !== nd.innerHTML) { dd.innerHTML = nd.innerHTML; replay(dd, "changed"); changed = true; }
    }
    for (const gone of old.values()) gone.remove();
    if (changed) replay(o, "updated");
  }

  function patchMoves(o, n) {
    const ol = o.querySelector("ol"), seen = new Set([...ol.children].map((li) => li.dataset.seq));
    o.querySelector(".terms-head").replaceWith(n.querySelector(".terms-head"));
    let delay = 0;
    for (const li of [...n.querySelectorAll("li")]) {
      if (seen.has(li.dataset.seq)) continue;
      li.classList.add("fresh");
      li.style.animationDelay = delay + "s";
      delay += 0.35;
      ol.append(li);
    }
  }

  // The mark stays (taking it off would restart the entrance), so compare
  // without it.
  const arrive = (el) => { el.classList.add("arriving"); return el; };
  const same = (a, b) => {
    if (!a.classList.contains("arriving")) return a.isEqualNode(b);
    const c = a.cloneNode(true);
    c.classList.remove("arriving");
    if (!c.classList.length) c.removeAttribute("class");
    return c.isEqualNode(b);
  };

  // Children that did not change stay as they are, so nothing replays its
  // entrance. Changed text blurs out and the new text resolves in its place.
  function morph(o, n) {
    const oc = [...o.children], nc = [...n.children];
    nc.forEach((next, i) => {
      const was = oc[i];
      if (!was) return later(LEAVE, () => o.append(arrive(next)));
      if (same(was, next)) return;
      const both = (sel) => was.matches(sel) && next.matches(sel);
      if (both(".duo")) return patchDuo(was, next);
      if (both(".terms")) return later(LAND, () => patchTerms(was, next));
      if (both(".moves")) return later(LAND, () => patchMoves(was, next));
      was.classList.add("leaving");
      later(LEAVE, () => was.replaceWith(arrive(next)));
    });
    for (const extra of oc.slice(nc.length)) {
      extra.classList.add("leaving");
      later(LEAVE, () => extra.remove());
    }
  }

  function swap(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const next = doc.querySelector(".split"), cur = split();
    if (!next || !cur) return location.reload();
    window.localTimes?.(doc);
    morph(cur.querySelector("section"), next.querySelector("section"));
    morph(cur.querySelector("aside"), next.querySelector("aside"));
    cur.dataset.v = next.dataset.v;
    cur.dataset.wait = next.dataset.wait;
    document.title = doc.title;
    later(LEAVE + 20, () => window.timeranges?.(cur));
  }

  // Someone filling in terms keeps their page until they send or leave them.
  const editing = (s) =>
    s.contains(document.activeElement) && document.activeElement.matches("input, select") ||
    [...s.querySelectorAll("input:not([type=hidden]), select")].some((i) =>
      i.tagName === "SELECT" ? [...i.options].some((o) => o.selected !== o.defaultSelected) : i.value !== i.defaultValue);

  let busy = false;
  async function check() {
    const s = split();
    if (busy || document.hidden || !s || s.dataset.wait !== "1" || editing(s)) return;
    busy = true;
    try {
      const r = await fetch(location.pathname + "/v", { cache: "no-store" });
      if ((await r.json()).v !== s.dataset.v) {
        swap(await (await fetch(location.pathname, { cache: "no-store" })).text());
      }
    } catch {} finally { busy = false; }
  }
  setInterval(check, 2000);
  document.addEventListener("visibilitychange", check);

  document.addEventListener("submit", async (e) => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement) || !form.closest(".split") || busy) return;
    e.preventDefault();
    busy = true;
    for (const b of form.querySelectorAll("button")) b.disabled = true;
    try {
      const r = await fetch(location.pathname, { method: "POST", body: new FormData(form, e.submitter) });
      swap(await r.text());
    } catch { form.submit(); } finally { busy = false; }
  });
})();
</script>`;

function message(title: string, text: string, status = 200): Response {
  return htmlResponse(
    page(
      title,
      `<p class="eyebrow">Taasky</p><h1>${escapeHtml(title)}</h1><p class="lede">${escapeHtml(text)}</p>`,
      { narrow: true },
    ),
    status,
  );
}

/** "From Ilya B. · email verified": a name the party chose to show, and the mark Google vouched for. */
function withLine(shown: db.Shown, lead: string): string {
  return `<p class="with">${lead} <strong>${escapeHtml(shown.name)}</strong>${
    shown.emailVerified ? '<span class="mark">Email verified</span>' : ""
  }</p>`;
}

function fieldList(schema: SubjectSchema): string {
  return `<ul class="fields">${Object.values(schema)
    .map((d) => `<li>${escapeHtml(d.label)}</li>`)
    .join("")}</ul>`;
}

// ── Invitation ───────────────────────────────────────────────────────────────

// People reopen the invitation from the chat it came in, long after they
// answered it. The browser that answered keeps its personal link in a cookie
// and is sent back to the room. Only that browser: whoever sent the
// invitation has the same link, and must not land in the other side's seat.
const ANSWERED_DAYS = 90;
const answeredCookie = (code: string) => `__Host-taasky_i_${code}`;

/**
 * The personal link this browser got for invitation `code`. Joining clears the
 * code from the room, so there is nothing to match it against: the cookie is
 * __Host- and HttpOnly, only this server sets it, and a person who forges one
 * already holds the token it names.
 */
async function answeredHere(deps: WebDeps, request: Request, code: string): Promise<string | null> {
  const token = readCookie(request, answeredCookie(code));
  if (!token || !/^[a-z0-9]{26}$/.test(token)) return null;
  return (await db.getWebLink(deps.DB, token)) ? token : null;
}

const toRoom = (token: string, cookie?: string) => {
  const headers = new Headers({ Location: `/p/${token}` });
  if (cookie) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
};

const BACK_TO_ROOM =
  "If you answered it, open the link in the browser you answered from, or use the link Taasky sent you in Telegram.";

function unavailable(e: MoveError): Response {
  switch (e.message) {
    case ANSWERED:
      return message(
        "This invitation is taken",
        `Someone has already answered it. ${BACK_TO_ROOM}`,
      );
    case WITHDRAWN:
      return message(
        "This invitation was withdrawn",
        "The person who sent it withdrew it before anyone answered. Ask them for a new one if you still want to settle this.",
      );
    case INVITE_EXPIRED:
      return message(
        "This invitation has expired",
        "Nobody answered it in time. Ask the person who sent it for a new one.",
      );
    case NO_INVITE:
      // Rooms joined before codes were kept look like this too.
      return message(
        "We can't find this invitation",
        `Check that the link is complete. ${BACK_TO_ROOM}`,
      );
  }
  return message("Invitation unavailable", `Sorry: ${e.message}.`);
}

/** What a messenger shows for an invite link. The image is served by taasky.ai. */
const invitePreview = (from: db.Shown | null) => ({
  title: from ? `${from.name} has a proposal for you` : "A proposal for you",
  description:
    "See the details and answer in a tap, or give it to your agent. Nothing is agreed until you both say yes.",
  image: "https://taasky.ai/og/invite.jpg",
});

/** The answer as an agent asked for it, or null for the page. */
function forAgent(
  format: InviteFormat,
  json: object,
  markdown: string,
  status = 200,
): Response | null {
  if (format === "html") return null;
  return new Response(format === "json" ? JSON.stringify(json, null, 2) : markdown, {
    status,
    headers: {
      "Content-Type":
        format === "json" ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8",
      "Cache-Control": "no-store",
      Vary: "Accept",
    },
  });
}

async function showInvite(deps: WebDeps, request: Request, code: string): Promise<Response> {
  const format = inviteFormat(request);
  const mine = format === "html" && (await answeredHere(deps, request, code));
  if (mine) return toRoom(mine);
  let initiator: db.Participant;
  let room: db.RoomRow;
  try {
    ({ initiator, room } = await openInvite(deps.DB, code, new Date()));
  } catch (e) {
    if (e instanceof MoveError) {
      const status = e.message === NO_INVITE ? 404 : 410;
      const error = { type: "taasky_invitation", invite_code: code, error: e.message };
      const text = `# Taasky invitation\n\nUnavailable: ${e.message}.\n`;
      return forAgent(format, error, text, status) ?? unavailable(e);
    }
    throw e;
  }
  // Opened with terms: show them, not just what they will be about.
  const opening = termsOnTable(await db.listMessages(deps.DB, room.id));
  // Opened with options: one tap picks one, and joins on the way.
  const options = opening && initiator.options?.length ? initiator.options : null;
  const from = await db.shownAs(deps.DB, initiator);
  const mcpUrl = `${deps.PUBLIC_BASE_URL}/mcp`;
  if (format !== "html") {
    const inv = agentInvite({
      code,
      baseUrl: deps.PUBLIC_BASE_URL,
      appUrl: appBase(deps),
      schema: initiator.subject_schema,
      opening: (opening?.subject as Record<string, unknown> | null | undefined) ?? null,
      options,
      expiresAt: room.invite_expires_at,
      from,
    });
    return forAgent(format, inv, agentInviteMarkdown(inv))!;
  }
  // People, not agents: the sender offers a quicker way to settle something,
  // and their agent is the help on their side (VOICE.md, the other side).
  const name = from ? escapeHtml(from.name) : null;
  const ask = options
    ? "Pick what works for you."
    : opening
      ? "Say yes, or suggest a change."
      : "Answer when it suits you.";
  return htmlResponse(
    page(
      from ? `A proposal from ${from.name}` : "A proposal for you",
      `<div class="split">
  <section>
    <p class="eyebrow">Invitation</p>
    <h1>${name ? `${name} has a proposal.` : "A proposal for you."} <em>${ask}</em></h1>
    ${from ? withLine(from, "From") : ""}
    <p class="lede">To save you both the back and forth, ${name ?? "they"} put it all on one page. Answer in a tap, or suggest something else. No account, no app.</p>
    <p>${name ? `${name}'s` : "Their"} agent handles the details on their side, so you hear back fast.</p>
    ${
      options
        ? optionsBlock(initiator.subject_schema, options, "")
        : opening?.subject
          ? `<section class="terms">
  <header class="terms-head"><span>The details</span><span>their suggestion</span></header>
  <dl class="facts">${factRows(initiator.subject_schema, opening.subject)}</dl>
</section>`
          : fieldList(initiator.subject_schema)
    }
    <form method="post" class="cta">
      <button${options ? "" : ' class="primary"'}>${options ? "None of these work? Suggest another" : "Answer"} <span class="arrow">&rarr;</span></button>
    </form>
    <p><small>Nothing is agreed until you both say yes. ${name ?? "The person who sent this"} wrote the labels above. Answering
    means you accept our <a href="https://taasky.ai/terms/">Terms</a> and
    <a href="https://taasky.ai/privacy/">Privacy Policy</a>.</small></p>
    <div class="side-note">
      <p class="eyebrow quiet" style="margin:0">Have an agent of your own?</p>
      <p>Give it this link, and it can answer for you. You still confirm. If it is not connected to
      Taasky yet, the address is <code>${escapeHtml(mcpUrl)}</code>.
      An agent can read this invitation as <a href="?format=md">Markdown</a> or
      <a href="?format=json">JSON</a>.</p>
    </div>
  </section>
  <aside>${plate("/img/invitation.webp", "A sealed envelope on a dark table, lit from above", "Fig. 1", "An invitation, sealed")}</aside>
</div>${opening ? LOCAL_TIME_SCRIPT : ""}`,
      { preview: invitePreview(from) },
    ),
    200,
    { Vary: "Accept" },
  );
}

async function acceptInvite(deps: WebDeps, request: Request, code: string): Promise<Response> {
  // Pressing the button twice, or going back and pressing it again.
  const mine = await answeredHere(deps, request, code);
  if (mine) return toRoom(mine);
  const picked = (await request.formData()).get("option");
  const now = new Date();
  const userId = newUserId();
  let roomId: string;
  try {
    const { initiator } = await openInvite(deps.DB, code, now);
    // A person declares no schema: they negotiate in the shape they were invited to.
    ({
      room: { id: roomId },
    } = await joinRoom(deps.DB, code, userId, initiator.subject_schema, now));
  } catch (e) {
    if (e instanceof MoveError) return unavailable(e);
    throw e;
  }
  const token = webToken();
  await db.insertWebLink(deps.DB, {
    token,
    user_id: userId,
    room_id: roomId,
    created_at: now.toISOString(),
  });
  await deps.notifier.roomChanged(roomId, userId);
  if (picked !== null) {
    try {
      await pickOption(deps.DB, await loadRoom(deps.DB, roomId, userId, now), Number(picked), now);
      await deps.notifier.roomChanged(roomId, userId);
    } catch (e) {
      // They are in the room either way; it shows what is still open.
      if (!(e instanceof MoveError)) throw e;
    }
  }
  // Lax: sent when the invitation is opened from a chat, which is a top-level
  // navigation from another site.
  return toRoom(
    token,
    `${answeredCookie(code)}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${ANSWERED_DAYS * 86400}`,
  );
}

// ── Room ─────────────────────────────────────────────────────────────────────

/** One value of a field as HTML. Values were validated against `type` on the way in. */
function showValue(type: FieldType, item: unknown): string {
  switch (type) {
    case "timerange": {
      const start = escapeHtml(String((item as { start: string }).start));
      const end = escapeHtml(String((item as { end: string }).end));
      return `<time datetime="${start}">${start}</time><span class="to"> – </span><time datetime="${end}" data-end>${end}</time>`;
    }
    case "money":
      return escapeHtml(formatMoney(item as { amount: string; currency: string }));
    case "date":
      return escapeHtml(formatDate(item as string));
    case "bool":
      return item ? "Yes" : "No";
    default:
      return escapeHtml(String(item));
  }
}

/** Terms as rows of facts, in the order their author declared the fields. */
function factRows(schema: SubjectSchema, subject: Record<string, unknown>): string {
  return Object.entries(schema)
    .filter(([field]) => subject[field] !== undefined)
    .map(([field, decl]) => {
      const v = subject[field];
      const shown = (Array.isArray(v) ? v : [v])
        .map((item) => showValue(decl.type, item))
        .join("<br>");
      return `<div><dt>${escapeHtml(decl.label)}</dt><dd>${shown}</dd></div>`;
    })
    .join("");
}

/**
 * The initiator's options, one button each: picking a time is one tap. The
 * pick is the person's yes, so the note says so before they press.
 */
function optionsBlock(
  schema: SubjectSchema,
  options: Record<string, unknown>[],
  hidden: string,
): string {
  const fields = Object.entries(schema).filter(([field]) => options[0]![field] !== undefined);
  const buttons = options
    .map((option, i) => {
      const shown = fields
        .map(([field, decl]) => {
          const v = option[field];
          return (Array.isArray(v) ? v : [v]).map((item) => showValue(decl.type, item)).join(", ");
        })
        .join(" · ");
      return `<button name="option" value="${i}">${shown}</button>`;
    })
    .join("");
  const labels = fields.map(([, decl]) => escapeHtml(decl.label)).join(" · ");
  return `<section class="terms">
  <header class="terms-head"><span>Pick one</span><span>${labels}</span></header>
  <form method="post" class="options">${hidden}${buttons}</form>
  <footer class="terms-foot">Your pick is your yes. Once they confirm, it's settled.</footer>
</section>`;
}

/**
 * How far apart the two spheres stand: they draw closer with each move, meet
 * on agreement, and part when the room closes without one.
 */
function nearness(loaded: LoadedRoom): number {
  if (loaded.room.state === "agreed") return 1;
  if (isTerminal(loaded.room.state)) return 0;
  return (Math.min(loaded.history.length, 6) / 6) * 0.7;
}

/** The terms on the table as facts: label in mono, value in serif. */
function termsBlock(loaded: LoadedRoom): { html: string; terms: db.MessageRow | null } {
  const terms = termsOnTable(loaded.history);
  if (!terms?.subject) {
    return {
      html: `<section class="terms"><header class="terms-head"><span>The details</span></header>
  <h2>Nothing yet.</h2>
  <p>The details will appear here.</p></section>`,
      terms: null,
    };
  }
  const author = loaded.parties.find((p) => p.id === terms.from_id)!;
  const rows = factRows(author.subject_schema, terms.subject);
  const agreed = loaded.room.state === "agreed";
  const by = agreed
    ? "the deal"
    : author.id === loaded.me.id
      ? "your suggestion"
      : "their suggestion";
  // One framed sheet, so the terms read as a single thing; once agreed, the
  // seal is pressed onto its corner.
  return {
    html: `<section class="terms${agreed ? " sealed" : ""}">
  <header class="terms-head"><span>The details</span><span>${by}</span></header>
  <dl class="facts">${rows}</dl>
  ${agreed ? `<footer class="terms-foot">Accepted by both sides</footer>` : ""}
  ${agreed ? `<img class="seal" src="/img/seal.webp" alt="Sealed by both sides" width="440" height="440">` : ""}
</section>`,
    terms,
  };
}

const VERBS: Record<string, string> = {
  offer: "suggested",
  counter: "suggested a change",
  need_more_detail: "asked for more detail",
  approve: "said yes",
  reject: "said no",
  cancel: "stepped out",
};

/**
 * Every move so far, oldest first: who, what they did, and for terms only the
 * fields that changed — the room's story at a glance. Each item carries its
 * seq, so a live page can tell which moves are new.
 */
function movesBlock(loaded: LoadedRoom, readOnly: boolean, them: string | null): string {
  if (!loaded.history.length) return "";
  let previous: Record<string, unknown> | null = null;
  const items = loaded.history.map((m) => {
    const mine = m.from_id === loaded.me.id;
    const who = mine ? (readOnly ? "Your agent" : "You") : them ? escapeHtml(them) : "They";
    let what = "";
    if (m.subject) {
      const subject = m.subject;
      const schema = loaded.parties.find((p) => p.id === m.from_id)!.subject_schema;
      const changed = Object.entries(schema).filter(
        ([field]) =>
          subject[field] !== undefined &&
          JSON.stringify(subject[field]) !== JSON.stringify(previous?.[field]),
      );
      what = changed.length
        ? changed
            .slice(0, 3)
            .map(([field, decl]) => {
              const v = subject[field];
              // A list of findings in one line is unreadable: say how it stands instead.
              const counts = Array.isArray(v) ? findingCounts(v) : null;
              const shown = counts
                ? escapeHtml(counts)
                : (Array.isArray(v) ? v : [v]).map((item) => showValue(decl.type, item)).join(", ");
              return `<span class="label">${escapeHtml(decl.label)}</span> ${shown}`;
            })
            .join('<span class="sep"> · </span>')
        : "the same terms again";
      previous = subject;
    }
    const ts = escapeHtml(m.ts);
    return `<li class="${mine ? "you" : "them"}" data-seq="${m.seq}"><span class="dot"></span>
  <div><p class="verb">${who} ${VERBS[m.verdict] ?? escapeHtml(m.verdict)}</p>${what ? `<p class="what">${what}</p>` : ""}</div>
  <time class="when" datetime="${ts}" data-clock>${ts}</time></li>`;
  });
  const n = loaded.history.length;
  return `<section class="moves"><header class="terms-head"><span>So far</span><span>${n} ${n === 1 ? "step" : "steps"}</span></header>
  <ol>${items.join("")}</ol></section>`;
}

/**
 * ISO times in the reader's own time zone; an end on the same day shows only
 * its time, and a move's time (data-clock) only the clock. A function, so the
 * live page can format a fetched page before comparing it with this one.
 */
const LOCAL_TIME_SCRIPT = `<script>
window.localTimes = (root) => {
  let lastDay = "";
  for (const t of root.querySelectorAll("time[datetime]")) {
    const d = new Date(t.dateTime);
    if (isNaN(d)) continue;
    if (t.hasAttribute("data-clock")) {
      t.textContent = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      continue;
    }
    const day = d.toDateString();
    t.textContent = t.hasAttribute("data-end") && day === lastDay
      ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
      : d.toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
    lastDay = day;
  }
};
localTimes(document);
</script>`;

/**
 * `draft`: the terms the person just tried to send, when they were refused —
 * the form keeps them, so a fix is one edit rather than starting over.
 * `readOnly`: the view of a human whose agent negotiates; no forms.
 */
async function showRoom(
  deps: WebDeps,
  link: db.WebLink,
  error?: string,
  draft?: Record<string, unknown>,
  readOnly = false,
): Promise<Response> {
  const loaded = await loadRoom(deps.DB, link.room_id, link.user_id, new Date());
  const { room, me } = loaded;
  const them = await db.shownAs(deps.DB, loaded.peer);
  const { html: termsHtml, terms } = termsBlock(loaded);
  const yourTurn = room.state === "awaiting" && room.turn === me.id;
  const done = isTerminal(room.state);
  const youMoved = loaded.history.some((m) => m.from_id === me.id);
  // Agreement takes both sides approving the same terms (§5), so once the
  // other side accepts yours, you confirm them too.
  const theyAccepted =
    terms !== null &&
    loaded.history.some(
      (m) =>
        m.seq > terms.seq &&
        m.from_id !== me.id &&
        m.verdict === "approve" &&
        m.subject_hash === terms.subject_hash,
    );

  // The other side by the name they show, else "they" (VOICE.md, the other side).
  const They = them?.name ?? "They";
  const they = them?.name ?? "they";
  const them_ = them?.name ?? "them";

  // A move the agent parked for this person: the page is theirs to answer.
  const asked = readOnly && !done ? await db.getOpenPendingMove(deps.DB, room.id, me.id) : null;

  // Headlines follow DESIGN.md: two lines, the second italic.
  const [title, lede, status]: [string, string, string] = asked
    ? [
        "Your agent asks you.",
        asked.verdict === "approve"
          ? "It wants to accept the terms on the right. Nothing is sent until you answer."
          : asked.verdict === "reject"
            ? "It wants to turn these terms down. Nothing is sent until you answer."
            : "It wants to withdraw from this negotiation. Nothing is sent until you answer.",
        "Your yes",
      ]
    : readOnly && !done
      ? room.state === "draft"
        ? ["Invitation sent.", "Your agent offers terms once the other side joins.", "Their move"]
        : yourTurn
          ? [
              terms ? "Their terms are in." : "The room is open.",
              "Your agent is on it. Anything it accepts comes to you here first.",
              "Your move",
            ]
          : ["Your side has answered.", "This page refreshes by itself.", "Their move"]
      : room.state === "agreed"
        ? [
            "Both sides said yes.",
            "Nothing left to do: both sides hold the same terms, sealed.",
            "Agreed",
          ]
        : room.state === "closed"
          ? ["No deal this time.", "One of you said no or stepped out.", "Closed"]
          : room.state === "expired"
            ? ["Time ran out.", "The deadline passed before both sides agreed.", "Expired"]
            : !yourTurn
              ? pickedAndConfirmed(loaded, me) ||
                (loaded.history.at(-1)?.from_id === me.id &&
                  loaded.history.at(-1)?.verdict === "approve")
                ? [
                    "You said yes.",
                    `Once ${they} confirms, it's settled. Nothing more to do here.`,
                    `Waiting for ${them_}`,
                  ]
                : youMoved
                  ? [
                      "Sent.",
                      "The reply shows up here as soon as it comes.",
                      `Waiting for ${them_}`,
                    ]
                  : [
                      "You're in.",
                      them
                        ? `${them.name}'s details will appear here in a moment.`
                        : "The details will appear here in a moment.",
                      `Waiting for ${them_}`,
                    ]
              : theyAccepted
                ? [`${They} said yes.`, "Confirm, and it's settled.", "Your turn"]
                : terms
                  ? [
                      them ? `${them.name} suggests this.` : "Here's their suggestion.",
                      "Say yes, or change what doesn't work.",
                      "Your turn",
                    ]
                  : ["Your turn to start.", "Suggest what works for you.", "Your turn"];
  const second =
    room.state === "agreed"
      ? "It's agreed."
      : done
        ? "The room is closed."
        : asked
          ? "Your call."
          : yourTurn
            ? readOnly
              ? "Your agent's move."
              : theyAccepted
                ? "Your turn to."
                : "Over to you."
            : readOnly
              ? "Now it's theirs."
              : `Over to ${them_}.`;
  const live = room.state === "agreed" ? "both" : done ? "none" : yourTurn ? "you" : "them";
  // Once agreed, the lede tells how it came together.
  const story =
    room.state === "agreed"
      ? replayStory(
          { history: loaded.history, parties: loaded.parties, me: me.id, agent: readOnly },
          showValue,
        )
      : null;

  // Left: where things stand. Right: the terms and what you can do about them.
  const lead: string[] = [
    // Rounds are for the human behind an agent; a person answering just sees the room.
    `<p class="eyebrow">${roomLabel(room.id)}${readOnly && room.round ? ` · Round ${room.round}` : ""}</p>`,
    `<h1>${escapeHtml(title)} <em>${escapeHtml(second)}</em></h1>`,
    ...(them ? [withLine(them, "With")] : []),
    `<p class="lede">${story ?? escapeHtml(lede)}</p>`,
  ];
  if (error) lead.push(`<p class="notice">${escapeHtml(error)}</p>`);
  // Under the joined spheres: how long it took.
  const pace = room.state === "agreed" ? replayPace(loaded.history) : null;
  lead.push(
    duo(live, pace ? `${status} · ${pace}` : status, nearness(loaded), {
      them: them?.name,
      people: !readOnly,
    }),
  );
  const moves = movesBlock(loaded, readOnly, them ? them.name : null);
  if (moves) lead.push(moves);

  const side: string[] = [];
  // The move the agent parked for this person: its card first, with the buttons.
  if (asked) {
    const card = await cardForPending(deps.DB, asked, link.user_id, new Date());
    side.push(cardHtml(card, cardMessage(card)));
  }
  side.push(termsHtml);
  const kind = readOnly ? "r" : "p";
  const event =
    room.state === "agreed"
      ? agreedEvent({
          roomId: room.id,
          state: room.state,
          history: loaded.history,
          parties: loaded.parties,
          them,
          url: `${appBase(deps)}/${kind}/${link.token}`,
        })
      : null;
  if (event) side.push(calendarBlock(event, `/${kind}/${link.token}/calendar.ics`));
  if (room.state === "agreed" && !readOnly) side.push(GET_TAASKY);

  const options = yourTurn && !readOnly ? openOptions(loaded) : null;
  if (options) {
    side[0] = optionsBlock(
      loaded.parties.find((p) => p.role === "initiator")!.subject_schema,
      options,
      `<input type="hidden" name="action" value="pick">`,
    );
  }
  if (yourTurn && !readOnly) {
    const actions: string[] = [];
    if (terms && !options && (terms.from_id !== me.id || theyAccepted)) {
      actions.push(`<form method="post">
    <input type="hidden" name="action" value="approve">
    <input type="hidden" name="hash" value="${escapeHtml(terms.subject_hash ?? "")}">
    <button class="primary">Yes, that works</button>
  </form>`);
    }
    if (terms && terms.from_id !== me.id) {
      actions.push(`<form method="post">
    <input type="hidden" name="action" value="reject">
    <button>No, thanks</button>
  </form>`);
    }
    if (actions.length) side.push(`<div class="actions">${actions.join("")}</div>`);
    side.push(`<details${terms && !draft ? "" : " open"}>
    <summary>${terms ? "Suggest something else" : "Suggest what works"}</summary>
    <form method="post">
      <input type="hidden" name="action" value="${terms ? "counter" : "offer"}">
      ${renderFields(me.subject_schema, draft ?? terms?.subject ?? {})}
      ${draft && error ? `<p class="notice">${escapeHtml(error)}</p>` : ""}
      <button${terms ? "" : ' class="primary"'}>Send to ${escapeHtml(them_)}</button>
    </form>
  </details>`);
  }

  if (readOnly && !done) {
    const note = [
      `<p class="eyebrow quiet" style="margin:0">Your agent negotiates this</p>
  <p>Accepting, turning down or withdrawing waits for your yes. It shows up on this page.</p>`,
    ];
    if (deps.bindUrl && !(await db.getChannel(deps.DB, link.user_id))) {
      note.push(`<p>Telegram can tell you when there's something to confirm, so you don't have to check back.</p>
  <a class="button inline" href="${escapeHtml(await deps.bindUrl(link.user_id))}">Tell me in Telegram <span class="arrow">&rarr;</span></a>`);
    }
    note.push(
      `<p><small>This is your personal link. Anyone who has it can answer for you.</small></p>`,
    );
    lead.push(`<div class="side-note">${note.join("\n")}</div>`);
  } else if (!done) {
    const note: string[] = [];
    if (deps.bindUrl) {
      const channel = await db.getChannel(deps.DB, link.user_id);
      note.push(
        channel
          ? `<p class="eyebrow quiet" style="margin:0">Telegram will tell you when there's a reply</p>`
          : `<p class="eyebrow quiet" style="margin:0">Rather get a message?</p>
  <p>Telegram can tell you when there's a reply, so you don't have to check back.</p>
  <a class="button inline" href="${escapeHtml(await deps.bindUrl(link.user_id))}">Tell me in Telegram <span class="arrow">&rarr;</span></a>`,
      );
    }
    note.push(`<p><small>This is your personal link. Bookmark it to come back. Anyone who has it can answer for you.</small></p>
  <form method="post">
    <input type="hidden" name="action" value="cancel">
    <button class="ghost">Step out of this</button>
  </form>`);
    lead.push(`<div class="side-note">${note.join("\n")}</div>`);
  }

  // An open room can change from either side at any time: a withdrawal, the
  // deadline, the same person on another device.
  const waiting = !done;
  const version = await roomVersion(deps.DB, room.id);
  return htmlResponse(
    page(
      roomName(room.id).name,
      `<div class="split" data-v="${version}" data-wait="${waiting ? 1 : 0}"><section>${lead.join("\n")}</section><aside>${side.join("\n")}</aside></div>${LOCAL_TIME_SCRIPT}${TIMERANGE_SCRIPT}${LIVE_SCRIPT}`,
      // Without JavaScript, never reload under a form someone may be filling in.
      { refreshSeconds: waiting && (readOnly || !yourTurn) ? 30 : undefined },
    ),
    error ? 422 : 200,
  );
}

/**
 * The person's answer to the card on /r. The form names the parked move, and
 * resolveHumanMove checks it is this person's and still pending.
 */
async function answerCard(deps: WebDeps, link: db.WebLink, request: Request): Promise<Response> {
  const json = request.headers.get("Accept")?.includes("application/json") ?? false;
  const form = await request.formData();
  const pending = String(form.get("pending") ?? "");
  const decision = String(form.get("decision") ?? "");
  const now = new Date();
  let result: { status: string; reason?: string };
  try {
    if (decision === "confirm" || decision === "decline") {
      result = await resolveHumanMove(deps.DB, link.user_id, pending, decision, now);
    } else if (decision === "instead") {
      const option = Number(form.get("option"));
      result = await counterInstead(deps.DB, link.user_id, pending, option, now);
    } else {
      return json
        ? Response.json({ error: "unknown decision" }, { status: 400 })
        : showRoom(deps, link, "That answer isn't one of the buttons.", undefined, true);
    }
  } catch (e) {
    if (!(e instanceof MoveError)) throw e;
    return json
      ? Response.json({ error: e.message }, { status: 409 })
      : showRoom(deps, link, `Not sent: ${e.message}.`, undefined, true);
  }
  if (result.status === "released" || result.status === "countered") {
    await deps.notifier.roomChanged(link.room_id, link.user_id);
  }
  if (json) return Response.json(result);
  const stale =
    result.status === "stale"
      ? `Not sent: the room moved since this card (${result.reason}).`
      : undefined;
  return stale
    ? showRoom(deps, link, stale, undefined, true)
    : new Response(null, { status: 303, headers: { Location: `/r/${link.token}` } });
}

async function move(deps: WebDeps, link: db.WebLink, form: FormData): Promise<Response> {
  const now = new Date();
  const action = String(form.get("action"));
  let draft: Record<string, unknown> | undefined;
  let schema: SubjectSchema | undefined;
  try {
    const loaded = await loadRoom(deps.DB, link.room_id, link.user_id, now);
    schema = loaded.me.subject_schema;
    let req: { verdict: Verdict; subject?: unknown; subject_hash?: string };
    if (action === "pick") {
      await pickOption(deps.DB, loaded, Number(form.get("option")), now);
      await deps.notifier.roomChanged(link.room_id, link.user_id);
      return new Response(null, { status: 303, headers: { Location: `/p/${link.token}` } });
    }
    if (action === "approve") req = { verdict: "approve", subject_hash: String(form.get("hash")) };
    else if (action === "reject" || action === "cancel") req = { verdict: action };
    else if (action === "offer" || action === "counter") {
      draft = parseFields(loaded.me.subject_schema, form);
      req = { verdict: action, subject: draft };
    } else return showRoom(deps, link, "Unknown action.");

    await playMove(deps.DB, loaded, req, now, true);
  } catch (e) {
    if (e instanceof MoveError || e instanceof SubjectError) {
      return showRoom(deps, link, `Not sent: ${forPeople(e.message, schema)}.`, draft);
    }
    throw e;
  }
  await deps.notifier.roomChanged(link.room_id, link.user_id);
  await noticeCircling(deps.DB, deps.notifier, link.room_id);
  return new Response(null, { status: 303, headers: { Location: `/p/${link.token}` } });
}

/** "subject.meeting_time: …" is for agents; a person reads the field's label. */
function forPeople(message: string, schema: SubjectSchema | undefined): string {
  return message.replace(/subject\.([a-z][a-z0-9_]*)(\[\d+\])?/g, (whole, field: string) => {
    const label = schema?.[field]?.label;
    return label ? `“${label}”` : whole;
  });
}
