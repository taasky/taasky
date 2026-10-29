// Telegram, the v1 human channel (PROTOCOL.md §8). Three jobs:
//  - deliver confirmation cards with confirm / decline buttons;
//  - bind a chat to a Taasky user through t.me/<bot>?start=<code> (§10);
//  - turn a button press into resolveHumanMove, the only way a gated move is
//    released. Only the bound chat's buttons count.

import { offerClaimNow } from "./account/claim.js";
import { loginLink } from "./account/session.js";
import type { Analytics } from "./analytics.js";
import { configuredUpstreams, UPSTREAMS, type UpstreamEnv } from "./auth/upstream.js";
import { agreedEvent } from "./calendar.js";
import * as db from "./db.js";
import { listDeals, roomUrlFor, STANDING } from "./deals.js";
import { formatDate, formatMoney } from "./format.js";
import { appBase, type HostEnv } from "./hosts.js";
import { bindCode, userId as newUserId } from "./ids.js";
import { cardForPending, counterInstead, resolveHumanMove } from "./moves.js";
import { roomName } from "./names.js";
import type { CardField, ConfirmationCard, Notifier } from "./notifier.js";
import type { HumanGatedVerdict } from "./protocol/envelope.js";
import type { Breach } from "./protocol/limits.js";
import { termsOnTable } from "./protocol/move.js";
import { MoveError } from "./protocol/state.js";
import type { FieldType } from "./protocol/subject.js";
import {
  FINDING_STATUS,
  FINDING_STATUSES,
  type Finding,
  findingNotes,
  readFinding,
} from "./protocol/understanding.js";
import { replayPace, replayStory } from "./replay.js";
import { shownText } from "./shown.js";

export const WEBHOOK_PATH = "/telegram/webhook";
const BIND_TTL_DAYS = 7;

export interface TelegramEnv extends UpstreamEnv, HostEnv {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
}

async function api<T = unknown>(
  env: TelegramEnv,
  method: string,
  body: object,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const json = (await res.json()) as { ok: boolean; result?: T; description?: string };
  if (!json.ok) throw new Error(`telegram ${method}: ${json.description ?? res.status}`);
  return json.result as T;
}

/** Telegram echoes it on every webhook call. Derived, so the token is the only secret. */
async function webhookSecret(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`webhook:${token}`),
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

let username: string | null = null;
async function botUsername(env: TelegramEnv): Promise<string> {
  username ??= (await api<{ username: string }>(env, "getMe", {})).username;
  return username;
}

/** Who the chat is, for the owner's account page only: asked live, never stored. */
export interface TelegramChat {
  username: string | null;
  name: string | null;
}

export async function chatOf(env: TelegramEnv, chatId: string): Promise<TelegramChat | null> {
  try {
    const c = await api<{ username?: string; first_name?: string; last_name?: string }>(
      env,
      "getChat",
      { chat_id: chatId },
      // The account page waits for this; a slow Telegram must not hold it.
      AbortSignal.timeout(1500),
    );
    const name = [c.first_name, c.last_name].filter(Boolean).join(" ") || null;
    return { username: c.username ?? null, name };
  } catch (e) {
    console.error(JSON.stringify({ event: "telegram_chat_failed", error: String(e) }));
    return null;
  }
}

// ── Rendering ────────────────────────────────────────────────────────────────

const escapeHtml = (value: string) =>
  value.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

// One emoji per stage, so a glance at the chat tells where each room stands:
// 🟡 your answer is needed · 👋 joined · 📨 terms · 🔁 different terms ·
// ❓ more detail · 👍 accepted · ⏳ waiting for them · 🤝 agreed ·
// ❌ turned down · 🚪 withdrawn · ⌛ expired.
const ASK: Record<HumanGatedVerdict, { question: string; yes: string; no?: string }> = {
  approve: { question: "🟡 <b>Accept these terms?</b>", yes: "✅ Accept" },
  reject: { question: "🟡 <b>Turn down these terms?</b>", yes: "👎 Turn down" },
  cancel: {
    question: "🟡 <b>Stop here?</b> The room closes for both sides and nothing is agreed.",
    yes: "🚪 Stop",
    no: "↩️ Keep going",
  },
};

/** First line of every message about a room: "🦊 Amber Fox · Round 2". */
function heading(roomId: string, round?: number, them?: db.Shown | null): string {
  const { emoji, name } = roomName(roomId);
  return `${emoji} <b>${name}</b>${round ? ` · Round ${round}` : ""}${them ? `\nwith ${escapeHtml(shownText(them))}` : ""}`;
}

/** Who `userId` is dealing with in the room, when they show it. */
async function themIn(
  env: TelegramEnv,
  roomId: string,
  userId: string,
  parties?: db.Participant[],
) {
  const all = parties ?? (await db.getParticipants(env.DB, roomId));
  return db.shownAs(
    env.DB,
    all.find((p) => p.user_id !== userId),
  );
}

const termLines = (fields: CardField[]) =>
  fields.map(
    (f) =>
      `• <b>${escapeHtml(f.label)}</b>: ${formatValue(f.type, f.value)}` +
      (f.breaches ?? []).map((b) => `\n   ⚠️ <i>${breachText(f.type, b)}</i>`).join(""),
  );

/** One broken limit, in the confirming human's words. They set the bound, so it is theirs to see. */
export function breachText(type: FieldType, b: Breach): string {
  switch (b.rule) {
    case "below_min":
      return type === "timerange"
        ? `starts before your earliest, ${tgTime(b.bound as string, "wDt")}`
        : `below your minimum of ${formatValue(type, b.bound)}`;
    case "above_max":
      return type === "timerange"
        ? `ends after your latest, ${tgTime(b.bound as string, "wDt")}`
        : `above your limit of ${formatValue(type, b.bound)}`;
    case "not_allowed":
      return `not one you allowed (${escapeHtml((b.bound as string[]).join(", "))})`;
    case "not_equal":
      return `you asked for ${b.bound ? "yes" : "no"}`;
    case "other_currency":
      return `in another currency than your limit of ${formatValue(type, b.bound)}`;
  }
}

/**
 * A moment Telegram shows in the reader's own time zone and language. The
 * text inside is the fallback for clients that predate the tag, so it says UTC.
 */
function tgTime(iso: string, format: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return escapeHtml(iso);
  const utc = new Date(ms).toLocaleString("en-GB", {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `<tg-time unix="${Math.floor(ms / 1000)}" format="${format}">${utc} UTC</tg-time>`;
}

/** A field value as escaped HTML. Values were validated against `type` on the way in. */
function formatValue(type: FieldType, value: unknown): string {
  if (Array.isArray(value)) return value.map((v) => formatValue(type, v)).join(", ");
  switch (type) {
    case "timerange": {
      const { start, end } = value as { start: string; end: string };
      // A short range ends the same day, so its end needs only the time.
      const short = Date.parse(end) - Date.parse(start) < 12 * 3600_000;
      return `${tgTime(start, "wDt")} – ${tgTime(end, short ? "t" : "wDt")}`;
    }
    case "money":
      return escapeHtml(formatMoney(value as { amount: string; currency: string }));
    case "date":
      return escapeHtml(formatDate(value as string));
    case "bool":
      return value ? "yes" : "no";
    default:
      return escapeHtml(String(value));
  }
}

// ── Shared-picture rooms (skill taasky-align) ────────────────────────────────
// The card is the person's approval, so it carries what the agent used to say
// in the chat: the topic and the conclusion, then where the sides still
// differ, then what they agreed, with each finding's reason.

/**
 * How a list of findings stands, by status, in the order a person cares about:
 * "2 disputed, 1 open, 5 agreed". Null when the items aren't findings.
 */
export function findingCounts(items: unknown[]): string | null {
  const counts = new Map<string, number>();
  for (const item of items) {
    const f = readFinding(item);
    if (!f) return null;
    counts.set(f.status, (counts.get(f.status) ?? 0) + 1);
  }
  if (!counts.size) return null;
  return FINDING_STATUSES.filter((st) => counts.has(st))
    .map((st) => `${counts.get(st)} ${FINDING_STATUS[st].count}`)
    .join(", ");
}

/** Telegram refuses a message over 4096 characters; leave room for the heading and links. */
const ALIGN_BUDGET = 3500;

/** A finding line as escaped HTML, with its reason or with the claim alone. */
function findingLine(f: Finding, withReason: boolean): string {
  const text = withReason
    ? [
        f.reason ? `${f.claim}: ${f.reason}` : f.claim,
        ...findingNotes(f).map(([label, note]) => `${label.toLowerCase()}: ${note}`),
      ].join("; ")
    : f.claim;
  const { tag: word } = FINDING_STATUS[f.status];
  const tag = word ? ` <i>${word}</i>` : "";
  return `• <b>F${f.n}</b>${tag} · ${escapeHtml(text)}`;
}

/**
 * The terms of a shared-picture room, or null for any other shape. Findings
 * the sides still differ on come first: those are what the person decides on.
 */
export function alignLines(fields: CardField[]): string[] | null {
  const by = new Map(fields.map((f) => [f.field, f]));
  const findings = by.get("findings");
  if (!by.has("topic") || !findings || !Array.isArray(findings.value)) return null;
  const parsed: Finding[] = [];
  const loose: string[] = [];
  for (const item of findings.value as unknown[]) {
    const f = readFinding(item);
    if (f) parsed.push(f);
    else loose.push(String(item));
  }
  const apart = parsed.filter((f) => !f.status.startsWith("agreed"));
  const agreed = parsed.filter((f) => f.status.startsWith("agreed"));
  const value = (field: string) => {
    const f = by.get(field);
    return f ? `<b>${escapeHtml(f.label)}</b>: ${formatValue(f.type, f.value)}` : null;
  };
  const steps = by.get("next_steps");
  const stepList = Array.isArray(steps?.value) ? (steps.value as unknown[]).map(String) : [];

  // Shorten agreed findings to their claim first, then cut from the end, until it fits.
  const render = (agreedReasons: boolean, keep: number) => {
    const out: string[] = [value("topic")!];
    const conclusion = value("conclusion");
    if (conclusion && String(by.get("conclusion")?.value ?? "").trim()) out.push(conclusion);
    const items: string[] = [];
    if (apart.length)
      items.push("", "Where you still differ:", ...apart.map((f) => findingLine(f, true)));
    if (agreed.length)
      items.push("", "Agreed:", ...agreed.map((f) => findingLine(f, agreedReasons)));
    if (loose.length)
      items.push(
        "",
        `<b>${escapeHtml(findings.label)}</b>:`,
        ...loose.map((t) => `• ${escapeHtml(t)}`),
      );
    const shown = items.slice(0, keep);
    const cut = items.slice(keep).filter((l) => l.startsWith("•")).length;
    out.push(...shown);
    if (cut) out.push(`…and ${cut} more. Open the room to read them all.`);
    if (stepList.length) {
      out.push(
        "",
        `<b>${escapeHtml(steps!.label)}</b>:`,
        ...stepList.map((t) => `• ${escapeHtml(t)}`),
      );
    }
    return { out, total: items.length };
  };
  let r = render(true, Number.POSITIVE_INFINITY);
  if (r.out.join("\n").length > ALIGN_BUDGET) r = render(false, Number.POSITIVE_INFINITY);
  for (let keep = r.total - 1; r.out.join("\n").length > ALIGN_BUDGET && keep > 0; keep--) {
    r = render(false, keep);
  }
  return r.out;
}

/**
 * The card as a Telegram message. Field labels and values come from the
 * declared schema and the tabled terms, never from the agent (§8), and are
 * escaped: the peer wrote them.
 */
export function cardMessage(card: ConfirmationCard, roomUrl?: string, them?: db.Shown | null) {
  const outside = card.verdict === "approve" && card.terms?.limits === "outside";
  const align = card.terms ? alignLines(card.terms.fields) : null;
  const ask =
    align && card.verdict === "approve"
      ? card.terms?.by === "you"
        ? {
            question:
              "🟡 <b>Stand by this list?</b> If the other side approves it, it is settled without asking you again.",
            yes: "✅ Stand by it",
          }
        : {
            question: "🟡 <b>Is this your view?</b> Approving settles the list below.",
            yes: "✅ Approve",
          }
      : outside
        ? { question: "⚠️ <b>Accept terms outside your limits?</b>", yes: "⚠️ Accept anyway" }
        : card.verdict === "approve" && card.terms?.by === "you"
          ? {
              question:
                "🟡 <b>Stand by these terms?</b> If the other party accepts them, it is agreed without asking you again.",
              yes: "✅ Stand by them",
            }
          : ASK[card.verdict];
  const lines = [heading(card.room, card.round, them), ask.question, ""];
  if (card.terms) {
    if (align) {
      lines.push(
        card.terms.by === "you"
          ? "The list you put forward:"
          : "The list the other side put forward:",
      );
      lines.push(...align);
    } else {
      lines.push(
        card.terms.by === "you" ? "Terms you proposed:" : "Terms the other party proposed:",
      );
      lines.push(...termLines(card.terms.fields));
    }
    if (card.terms.limits === "within") lines.push("", "✅ Within the limits you set.");
    if (card.terms.labels_untrusted) {
      lines.push("", "<i>The other party wrote these field names. Check the values.</i>");
    }
  } else {
    lines.push("No terms are on the table.");
  }
  // Counters the human can send with one tap. The terms go in the text,
  // where Telegram shows times in the reader's own zone; buttons cannot.
  const instead = card.instead ?? [];
  if (instead.length) {
    lines.push(
      "",
      instead.length === 1 ? "Or propose instead:" : "Or propose one of these instead:",
    );
    instead.forEach((alt, i) => {
      const what = alt.fields
        .map((f) => `<b>${escapeHtml(f.label)}</b>: ${formatValue(f.type, f.value)}`)
        .join(", ");
      const tag = alt.closest
        ? " <i>(as close as your limits allow; sending it shows them that bound)</i>"
        : "";
      lines.push(`${instead.length === 1 ? "↩️" : `${i + 1}.`} ${what}${tag}`);
    });
  }
  return {
    text: lines.join("\n"),
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: ask.yes, callback_data: `c:${card.pending_id}` },
          { text: ("no" in ask && ask.no) || "❌ Don't", callback_data: `d:${card.pending_id}` },
        ],
        ...(instead.length
          ? [
              instead.map((_, i) => ({
                text: instead.length === 1 ? "↩️ Propose this instead" : `↩️ Propose ${i + 1}`,
                callback_data: `o:${card.pending_id}:${i}`,
              })),
            ]
          : []),
        ...(roomUrl ? [[{ text: "Open the negotiation", url: roomUrl }]] : []),
      ],
    },
  };
}

/** roomUrlFor, with the bot's database and base URL. */
function roomUrl(env: TelegramEnv, userId: string, roomId: string): Promise<string> {
  return roomUrlFor(env.DB, appBase(env), userId, roomId);
}

async function sendCard(env: TelegramEnv, chatId: string, userId: string, card: ConfirmationCard) {
  await api(env, "sendMessage", {
    chat_id: chatId,
    ...cardMessage(
      card,
      await roomUrl(env, userId, card.room),
      await themIn(env, card.room, userId),
    ),
  });
}

const say = (env: TelegramEnv, chatId: string | number, text: string, replyTo?: number) =>
  api(env, "sendMessage", {
    chat_id: chatId,
    text,
    ...(replyTo ? { reply_parameters: { message_id: replyTo } } : {}),
  });

// ── Notifier ─────────────────────────────────────────────────────────────────

/** t.me link that binds the chat it is opened in to `userId`. */
export async function bindUrl(env: TelegramEnv, userId: string): Promise<string> {
  const now = new Date();
  const code = await db.bindCodeFor(
    env.DB,
    userId,
    {
      code: bindCode(),
      expires_at: new Date(now.getTime() + BIND_TTL_DAYS * 86400_000).toISOString(),
    },
    now.toISOString(),
  );
  return `https://t.me/${await botUsername(env)}?start=${code}`;
}

/** t.me link that opens the bot and asks it for a sign-in link to the account page. */
export async function signInUrl(env: TelegramEnv): Promise<string> {
  return `https://t.me/${await botUsername(env)}?start=${SIGN_IN}`;
}

const DID: Record<string, string> = {
  joined: "👋 They opened your invitation.",
  offer: "📨 They suggested the details.",
  counter: "🔁 They suggested a change.",
  need_more_detail: "❓ They asked for more detail.",
  approve: "👍 They said yes.",
  reject: "❌ They said no.",
  cancel: "🚪 They stepped out. It's closed.",
};

/**
 * Tells the other party's human what `actorUserId` just did. A person
 * answering in the browser hears about every move, with their link. Behind an
 * agent, the human hears only what the agent cannot be relied on to relay:
 * a person on the other side answering, and the end of the negotiation.
 */
async function roomChanged(
  env: TelegramEnv,
  roomId: string,
  actorUserId: string,
  room: db.RoomRow | null,
  parties: db.Participant[],
) {
  // Agreement is news for both sides, whoever made the last move.
  if (room?.state === "agreed") return sayAgreed(env, room, parties);
  const recipient = parties.find((p) => p.user_id !== actorUserId);
  if (!recipient) return;
  const channel = await db.getChannel(env.DB, recipient.user_id);
  if (!channel) return;

  const [history, theirLink, actorLink] = await Promise.all([
    db.listMessages(env.DB, roomId),
    db.webLinkFor(env.DB, recipient.user_id, roomId),
    db.webLinkFor(env.DB, actorUserId, roomId),
  ]);
  if (!room) return;
  const terminal = room.state !== "awaiting" && room.state !== "draft";
  if (!theirLink && !actorLink && !terminal) return;

  const event = history.at(-1)?.verdict ?? "joined";
  const lines = [
    heading(room.id, room.round, await themIn(env, roomId, recipient.user_id, parties)),
  ];
  if (room.state === "expired") {
    lines.push(
      parties.length < 2
        ? "⌛ Nobody joined before the invitation ran out."
        : "⌛ Time ran out before both sides agreed.",
    );
  } else {
    lines.push(DID[event] ?? "The other side moved.");
  }
  if (theirLink) {
    const url = `${appBase(env)}/p/${theirLink.token}`;
    const yourTurn = room.state === "awaiting" && room.turn === recipient.id;
    lines.push(
      yourTurn
        ? `👉 Your turn: <a href="${url}">see the details</a>.`
        : `<a href="${url}">Open it</a>.`,
    );
  } else {
    lines.push(
      `<a href="${await roomUrl(env, recipient.user_id, room.id)}">Open the negotiation</a>.`,
    );
  }
  await api(env, "sendMessage", {
    chat_id: channel.address,
    text: lines.join("\n"),
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
}

/**
 * The deal, to each side in their own chat: the agreed terms, so the chat
 * holds a record of them, a way into their calendar when the terms say when,
 * and their own link to the room. One message per chat.
 */
async function sayAgreed(env: TelegramEnv, room: db.RoomRow, parties: db.Participant[]) {
  const history = await db.listMessages(env.DB, room.id);
  const terms = termsOnTable(history);
  const author = terms && parties.find((p) => p.id === terms.from_id);
  const fields =
    terms?.subject && author
      ? Object.entries(author.subject_schema)
          .filter(([field]) => terms.subject![field] !== undefined)
          .map(([field, decl]) => ({
            field,
            type: decl.type,
            label: decl.label,
            value: terms.subject![field],
          }))
      : [];
  const told = new Set<string>();
  for (const party of parties) {
    const channel = await db.getChannel(env.DB, party.user_id);
    if (!channel || told.has(channel.address)) continue;
    told.add(channel.address);
    const them = await themIn(env, room.id, party.user_id, parties);
    const url = await roomUrl(env, party.user_id, room.id);
    const event = agreedEvent({ roomId: room.id, state: room.state, history, parties, them, url });
    const lines = [
      heading(room.id, room.round, them),
      "🤝 <b>Agreed.</b> Both sides accepted the same terms.",
    ];
    if (fields.length) lines.push("", ...termLines(fields));
    // How it came together, told from this side: "your agent" when one moved for them.
    const agent = !(await db.webLinkFor(env.DB, party.user_id, room.id));
    const story = replayStory({ history, parties, me: party.id, agent }, formatValue);
    const pace = replayPace(history);
    if (story || pace) {
      lines.push(
        "",
        `<i>${[story, pace && `${pace[0]!.toUpperCase()}${pace.slice(1)}.`].filter(Boolean).join(" ")}</i>`,
      );
    }
    await api(env, "sendMessage", {
      chat_id: channel.address,
      text: lines.join("\n"),
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: {
        inline_keyboard: [
          ...(event ? [[{ text: "📅 Add to calendar", url: `${url}#calendar` }]] : []),
          [{ text: "Open the deal", url }],
        ],
      },
    });
  }
}

/**
 * Both sides' limits cannot meet (§7). Each human hears it once, in their own
 * chat, with the field names in their own schema's words — and no numbers.
 */
async function limitsApart(env: TelegramEnv, roomId: string, fields: string[]) {
  const parties = await db.getParticipants(env.DB, roomId);
  for (const p of parties) {
    const channel = await db.getChannel(env.DB, p.user_id);
    if (!channel) continue;
    const names = fields.map((f) => `“${escapeHtml(p.subject_schema[f]?.label ?? f)}”`).join(", ");
    await api(env, "sendMessage", {
      chat_id: channel.address,
      text: [
        heading(roomId),
        `🧭 <b>No deal is possible on ${names}.</b>`,
        "Taasky compared the limits both sides set privately: they do not overlap. Neither side " +
          "saw the other's numbers. Unless one of you can go further, withdrawing saves you both the rounds.",
        `<a href="${await roomUrl(env, p.user_id, roomId)}">Open the negotiation</a>`,
      ].join("\n"),
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  }
}

/** Sends `lines` about a room to every party whose human is reachable, with their own link. */
async function tellBoth(env: TelegramEnv, roomId: string, lines: string[]) {
  for (const p of await db.getParticipants(env.DB, roomId)) {
    const channel = await db.getChannel(env.DB, p.user_id);
    if (!channel) continue;
    await api(env, "sendMessage", {
      chat_id: channel.address,
      text: [
        ...lines,
        `<a href="${await roomUrl(env, p.user_id, roomId)}">Open the negotiation</a>`,
      ].join("\n"),
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  }
}

/** The first a human hears of a room their agent opened or joined. */
async function roomEntered(
  env: TelegramEnv,
  roomId: string,
  userId: string,
  inviteUrl: string | null,
) {
  const channel = await db.getChannel(env.DB, userId);
  if (!channel) return;
  // Joined: the inviter may show their name. Opened: nobody is there yet.
  const lines = [heading(roomId, undefined, inviteUrl ? null : await themIn(env, roomId, userId))];
  if (inviteUrl) {
    lines.push(
      "🆕 Your agent opened this negotiation.",
      `The other side joins with this link, if your agent has not sent it yet: ${escapeHtml(inviteUrl)}`,
    );
  } else {
    lines.push("🆕 Your agent joined this negotiation. The other side states terms first.");
  }
  lines.push(`<a href="${await roomUrl(env, userId, roomId)}">Open the negotiation</a>`);
  await api(env, "sendMessage", {
    chat_id: channel.address,
    text: lines.join("\n"),
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
}

/** After the claim: what changed, in the chat that proved it. */
export async function sayClaimed(env: TelegramEnv, chatId: string, deals: number): Promise<void> {
  await say(
    env,
    chatId,
    deals === 1
      ? `Saved. Your deal is in your account now. /deals lists it. ${NAME_NEXT}`
      : `Saved. ${deals} deals are in your account now. /deals lists them. ${NAME_NEXT}`,
  );
}

const NAME_NEXT =
  "From your next negotiation, the other side sees your name instead of “your agent”. " +
  "Change it or hide it on your account page.";

/**
 * Right after an agreement, the first and then the third: save your deals to
 * an account. Never before a first deal, never after the third
 * (docs/accounts.md). The button is the bot's one-time sign-in link, so
 * pressing it proves the chat.
 */
async function offerClaim(env: TelegramEnv, chatId: string, a?: Analytics): Promise<void> {
  const userId = await offerClaimNow(env.DB, chatId);
  if (!userId) return;
  await api(env, "sendMessage", {
    chat_id: chatId,
    text: claimOffer(configuredUpstreams(env).map((p) => UPSTREAMS[p].label)),
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "Save to an account",
            url: await loginLink(env.DB, appBase(env), userId, new Date()),
          },
        ],
      ],
    },
  });
  a?.capture(userId, "claim_offered");
}

/** Draft copy (docs/accounts.md), naming only the sign-ins this deployment has. */
export const claimOffer = (providers: string[]) =>
  "Want every deal in one place, and your name on the next invitation? Save them to an " +
  `account. No password: sign in with ${providers.join(" or ")}.`;

export function telegramNotifier(env: TelegramEnv, a?: Analytics): Notifier {
  const quietly = (event: string) => (e: unknown) =>
    console.error(JSON.stringify({ event, error: String(e) }));
  return {
    async roomEntered(roomId, userId, inviteUrl) {
      await roomEntered(env, roomId, userId, inviteUrl).catch(quietly("telegram_notify_failed"));
    },
    async circling(roomId) {
      await tellBoth(env, roomId, [
        heading(roomId),
        "🔄 <b>Going in circles.</b> The last few moves brought no new terms.",
        "Step in: tell your agent what you can live with, or withdraw. A clean no-deal beats another round.",
      ]).catch(quietly("telegram_notify_failed"));
    },
    async limitsApart(roomId, fields) {
      try {
        await limitsApart(env, roomId, fields);
      } catch (e) {
        console.error(JSON.stringify({ event: "telegram_notify_failed", error: String(e) }));
      }
    },
    async bindLink(userId) {
      return (await db.getChannel(env.DB, userId)) ? null : bindUrl(env, userId);
    },
    async roomChanged(roomId, actorUserId) {
      try {
        const [room, parties] = await Promise.all([
          db.getRoom(env.DB, roomId),
          db.getParticipants(env.DB, roomId),
        ]);
        await roomChanged(env, roomId, actorUserId, room, parties);
        // Saving takes a Google or GitHub sign-in: no offer while neither is configured.
        if (room?.state === "agreed" && configuredUpstreams(env).length) {
          // Both sides, each in their own chat, once per chat.
          const channels = await Promise.all(parties.map((p) => db.getChannel(env.DB, p.user_id)));
          const chats = new Set(channels.flatMap((c) => (c ? [c.address] : [])));
          await Promise.all([...chats].map((chat) => offerClaim(env, chat, a)));
        }
      } catch (e) {
        console.error(JSON.stringify({ event: "telegram_notify_failed", error: String(e) }));
      }
    },
    async requestConfirmation(userId, card) {
      const channel = await db.getChannel(env.DB, userId);
      if (!channel) return { delivered: false, bind_url: await bindUrl(env, userId) };
      try {
        await sendCard(env, channel.address, userId, card);
      } catch (e) {
        console.error(JSON.stringify({ event: "telegram_send_failed", error: String(e) }));
        throw new MoveError(
          "could not reach your human on Telegram. They may have blocked the Taasky bot.",
        );
      }
      return { delivered: true };
    },
  };
}

// ── Webhook ──────────────────────────────────────────────────────────────────

interface Chat {
  id: number;
  type: string;
}
interface Message {
  message_id: number;
  chat: Chat;
  text?: string;
}
interface CallbackQuery {
  id: string;
  data?: string;
  message?: Message;
}
interface Update {
  message?: Message;
  callback_query?: CallbackQuery;
}

const HELP =
  "Taasky confirms the deals your AI agent negotiates. Nothing is agreed without your tap " +
  "here. To connect, open the link your agent gives you. /deals lists your deals, /account opens your agents.";

/**
 * A bind link that no longer works. Opening the same link twice lands here too:
 * Telegram sends /start again, and the code was spent on the first tap. If this
 * chat is already connected, say so, or the human and their agent go looking
 * for a link that isn't needed.
 */
export const usedLinkReply = (chatConnected: boolean) =>
  chatConnected
    ? "This link was already used, and this chat is connected. Confirmations come here. /deals lists your deals."
    : "This link has expired or was already used. Ask your agent to try again. It will get a new one.";

/** The /start payload of signInUrl. Bind codes are 16 characters, so it cannot collide. */
const SIGN_IN = "login";

/** Points the bot at this Worker. Idempotent, and harmless to call by anyone. */
export async function setupWebhook(env: TelegramEnv): Promise<void> {
  await api(env, "setWebhook", {
    url: `${env.PUBLIC_BASE_URL}${WEBHOOK_PATH}`,
    secret_token: await webhookSecret(env.TELEGRAM_BOT_TOKEN),
    allowed_updates: ["message", "callback_query"],
  });
}

/** What a button press sets off beyond the bot itself. */
export interface WebhookDeps {
  /** Tells the other side about a released move; index.ts wraps it with analytics. */
  notifier: Notifier;
  analytics: Analytics;
}

export async function handleWebhook(
  request: Request,
  env: TelegramEnv,
  deps: WebhookDeps,
): Promise<Response> {
  const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (secret !== (await webhookSecret(env.TELEGRAM_BOT_TOKEN))) {
    return new Response("Forbidden", { status: 403 });
  }
  const update = (await request.json()) as Update;
  try {
    if (update.callback_query) await onButton(env, deps, update.callback_query);
    else if (update.message) await onMessage(env, deps, update.message);
  } catch (e) {
    // Answer 200 anyway: Telegram would otherwise redeliver the same update.
    console.error(JSON.stringify({ event: "telegram_update_failed", error: String(e) }));
  }
  return new Response("ok");
}

/** The last ten deals of everyone this chat confirms for, and of the ids they claimed. */
async function sendDeals(env: TelegramEnv, chatId: string) {
  const users = (await db.usersForTelegramChat(env.DB, chatId)).map((c) => c.user_id);
  const deals = await listDeals(env.DB, appBase(env), users, 10);
  const lines = deals.map(
    (d) =>
      `${heading(d.room)} · ${d.state === "agreed" ? "🤝 " : ""}${STANDING[d.state].toLowerCase()}${d.with ? ` · with ${escapeHtml(d.with)}` : ""} · <a href="${d.url}">open</a>`,
  );
  await api(env, "sendMessage", {
    chat_id: chatId,
    text: lines.length ? ["Your deals, newest first:", "", ...lines].join("\n") : "No deals yet.",
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
}

async function onMessage(env: TelegramEnv, deps: WebhookDeps, message: Message) {
  const chat = message.chat;
  // A group would let every member press the buttons.
  if (chat.type !== "private") return;

  const [command, code] = (message.text ?? "").trim().split(/\s+/);
  if (command === "/account" || (command === "/start" && (!code || code === SIGN_IN))) {
    return sendSignIn(env, deps, String(chat.id));
  }
  if (command === "/deals") return sendDeals(env, String(chat.id));
  if (command !== "/start" || !code) return void (await say(env, chat.id, HELP));

  const now = new Date();
  const userId = await db.takeBindCode(env.DB, code, now.toISOString());
  if (!userId) {
    const connected = await db.chatConnected(env.DB, "telegram", String(chat.id));
    return void (await say(env, chat.id, usedLinkReply(connected)));
  }
  const bound = await db.bindChannel(env.DB, {
    user_id: userId,
    kind: "telegram",
    address: String(chat.id),
    created_at: now.toISOString(),
  });
  if (!bound) {
    return void (await say(env, chat.id, "This Taasky account is already connected to a chat."));
  }
  // The rooms this account is already in, so the human can look before
  // anything needs their answer.
  const rooms = await Promise.all(
    (await db.listRoomsForUsers(env.DB, [userId])).map(
      async (r) =>
        `${heading(r.id)} · <a href="${await roomUrl(env, userId, r.id)}">open the negotiation</a>`,
    ),
  );
  await api(env, "sendMessage", {
    chat_id: chat.id,
    text: [
      "Connected. When your agent needs your confirmation, it will come here.",
      ...(rooms.length ? ["", ...rooms] : []),
    ].join("\n"),
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
  deps.analytics.capture(userId, "telegram_bound");

  // Whatever the agent asked before the human arrived.
  for (const pending of await db.listOpenPendingForUser(env.DB, userId)) {
    try {
      await sendCard(
        env,
        String(chat.id),
        userId,
        await cardForPending(env.DB, pending, userId, now),
      );
    } catch (e) {
      if (!(e instanceof MoveError)) throw e;
    }
  }
}

/**
 * One-time links to the account page of every account this chat confirms for.
 * A chat with none gets a new account bound to it: Telegram is then both how
 * the person signs in and where their confirmations go.
 */
async function sendSignIn(env: TelegramEnv, deps: WebhookDeps, chatId: string) {
  const now = new Date();
  let accounts = await db.usersForTelegramChat(env.DB, chatId);
  if (accounts.length === 0) {
    const channel = {
      user_id: newUserId(),
      kind: "telegram" as const,
      address: chatId,
      created_at: now.toISOString(),
    };
    await db.bindChannel(env.DB, channel);
    deps.analytics.capture(channel.user_id, "telegram_bound", { source: "account" });
    accounts = [channel];
  }
  const buttons = await Promise.all(
    accounts.map(async (c, i) => [
      {
        text:
          accounts.length === 1
            ? "Open your Taasky account"
            : `Account ${i + 1} · since ${formatDate(c.created_at.slice(0, 10))}`,
        url: await loginLink(env.DB, appBase(env), c.user_id, now),
      },
    ]),
  );
  await api(env, "sendMessage", {
    chat_id: chatId,
    text:
      accounts.length === 1
        ? "Your agents and keys are on your account page. The link works once, for 15 minutes."
        : "This chat confirms for more than one Taasky account, one per agent that connected " +
          "on its own. Pick one. Each link works once, for 15 minutes.",
    reply_markup: { inline_keyboard: buttons },
  });
}

function outcomeText(
  verdict: HumanGatedVerdict,
  result: Awaited<ReturnType<typeof resolveHumanMove>>,
): string {
  if (result.status === "declined") return "↩️ Okay, nothing was sent.";
  if (result.status === "stale") {
    return "⚠️ Not sent: the negotiation changed after your agent asked. Ask it to look again.";
  }
  if (verdict === "approve") {
    return result.state === "agreed"
      ? "🤝 Accepted. Both sides accepted the same terms. The deal is agreed."
      : "⏳ Accepted. Waiting for the other party to accept too.";
  }
  if (verdict === "reject") return "❌ Turned down. Your agent can keep negotiating.";
  return "🚪 Stopped. The room is closed for both sides and nothing was agreed.";
}

async function onButton(env: TelegramEnv, deps: WebhookDeps, query: CallbackQuery) {
  const answer = (text: string) =>
    api(env, "answerCallbackQuery", { callback_query_id: query.id, text });

  // c: confirm, d: don't, o:<n>: send the card's counter n instead.
  const match = /^(?:([cd]):(pm_[a-z0-9]+)|o:(pm_[a-z0-9]+):(\d))$/.exec(query.data ?? "");
  const message = query.message;
  if (!match || !message) return void (await answer("Unknown button."));
  const pendingId = match[2] ?? match[3]!;
  const decision = match[1] === "c" ? "confirm" : match[1] === "d" ? "decline" : "counter";

  const owner = await db.ownerOfPendingMove(env.DB, pendingId);
  const channel = owner ? await db.getChannel(env.DB, owner) : null;
  if (!owner || channel?.address !== String(message.chat.id)) {
    return void (await answer("This is not yours to answer."));
  }
  const pending = (await db.getPendingMove(env.DB, pendingId))!;

  let text: string;
  let agreed = false;
  try {
    const now = new Date();
    const result =
      decision === "counter"
        ? await counterInstead(env.DB, owner, pendingId, Number(match[4]), now)
        : await resolveHumanMove(env.DB, owner, pendingId, decision, now);
    text =
      result.status === "countered"
        ? "↩️ Sent. You proposed different terms; now it's their move."
        : outcomeText(pending.verdict, result);
    agreed = result.status === "released" && result.state === "agreed";
    deps.analytics.capture(owner, "confirmation_answered", {
      room: pending.room_id,
      verdict: pending.verdict,
      decision,
      status: result.status,
    });
    // A standing yes to one's own terms changes nothing the other side sees.
    if (
      (result.status === "released" && !("standing" in result)) ||
      result.status === "countered"
    ) {
      await deps.notifier.roomChanged(pending.room_id, owner);
    }
  } catch (e) {
    if (!(e instanceof MoveError)) throw e;
    text = `⚠️ Nothing to do: ${e.message}.`;
  }
  await answer(text);
  await api(env, "editMessageReplyMarkup", {
    chat_id: message.chat.id,
    message_id: message.message_id,
    reply_markup: { inline_keyboard: [] },
  });
  // An agreement brings its own message, with the deal, to both sides (sayAgreed).
  if (agreed) return;
  const url = await roomUrl(env, owner, pending.room_id);
  await api(env, "sendMessage", {
    chat_id: message.chat.id,
    text: `${heading(pending.room_id)}\n${escapeHtml(text)}\n<a href="${url}">Open the negotiation</a>`,
    parse_mode: "HTML",
    reply_parameters: { message_id: message.message_id },
    link_preview_options: { is_disabled: true },
  });
}
