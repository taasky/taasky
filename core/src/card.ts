// What an agent shows its human, written by Taasky rather than retold by the
// agent. Retold terms drift: an hour off, a price rounded, "sent" when the
// server refused. The card is plain text, in the human's time zone when the
// agent knows it, and says plainly whether anything is agreed.

import type { MessageRow, Shown } from "./db.js";
import { formatDate, formatMoney } from "./format.js";
import type { Breach } from "./protocol/limits.js";
import { termsOnTable } from "./protocol/move.js";
import type { RoomState } from "./protocol/state.js";
import type { FieldType, SubjectSchema } from "./protocol/subject.js";
import { shownText } from "./shown.js";

/** Whether `zone` is an IANA time zone this runtime knows ("Europe/Lisbon"). */
export function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const RFC3339 = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/i;

const DAY: Intl.DateTimeFormatOptions = {
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
};
const TIME: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };

/**
 * A moment as its day and its time, in `timeZone`, or else in the UTC offset
 * it was written with: that offset is the proposer's own clock.
 */
function moment(iso: string, timeZone?: string): { day: string; time: string; zone: string } {
  const m = RFC3339.exec(iso);
  if (!m) return { day: iso, time: "", zone: "" };
  if (timeZone) {
    const at = new Date(Date.parse(iso));
    return {
      day: at.toLocaleDateString("en-GB", { ...DAY, timeZone }),
      time: at.toLocaleTimeString("en-GB", { ...TIME, timeZone }),
      zone: timeZone,
    };
  }
  // The wall clock as written, read as if it were UTC so nothing shifts it.
  const wall = new Date(`${m[1]}T${m[2]}:00Z`);
  const offset = m[3]!.toUpperCase() === "Z" ? "+00:00" : m[3]!;
  return {
    day: wall.toLocaleDateString("en-GB", { ...DAY, timeZone: "UTC" }),
    time: wall.toLocaleTimeString("en-GB", { ...TIME, timeZone: "UTC" }),
    zone: `UTC${offset}`,
  };
}

/** A field value as a human reads it. Values were validated against `type` on the way in. */
export function formatValue(type: FieldType, value: unknown, timeZone?: string): string {
  if (Array.isArray(value)) return value.map((v) => formatValue(type, v, timeZone)).join("; ");
  switch (type) {
    case "timerange": {
      const { start, end } = value as { start: string; end: string };
      const a = moment(start, timeZone);
      const b = moment(end, timeZone);
      const zone = a.zone === b.zone ? ` (${a.zone})` : "";
      const to = a.day === b.day ? b.time : `${b.day}, ${b.time}`;
      return zone
        ? `${a.day}, ${a.time} – ${to}${zone}`
        : `${a.day}, ${a.time} (${a.zone}) – ${b.day}, ${b.time} (${b.zone})`;
    }
    case "money":
      return formatMoney(value as { amount: string; currency: string });
    case "date":
      return formatDate(value as string);
    case "bool":
      return value ? "yes" : "no";
    default:
      return String(value);
  }
}

export interface CardInput {
  name: string;
  /** The other side, when they show their name. */
  with?: Shown | null;
  state: RoomState;
  yourTurn: boolean;
  /** Your own schema: its labels are in your human's language. */
  schema: SubjectSchema;
  /** The other side's, for fields only they declared. */
  peerSchema: SubjectSchema | null;
  /** Your participant id, to tell your moves from theirs. */
  me: string;
  history: readonly MessageRow[];
  /** null: no limits were set; []: within them. */
  outside: Breach[] | null;
  limitsCannotMeet: string[];
  awaitingYourHuman: boolean;
  /** The other side's options, while you are picking from them. */
  options?: Record<string, unknown>[] | null;
  /** The terms on the table are ones the other side picked from your options and confirmed. */
  picked?: boolean;
  /** The other side accepted your terms as they stand. */
  theyAccepted?: boolean;
  /** You tapped Don't on this move, and nothing has happened in the room since. */
  youDeclined?: "approve" | "reject" | "cancel" | null;
  timeZone?: string;
}

/** The status line: the one sentence that must never be retold wrongly. */
function status(r: CardInput): string {
  switch (r.state) {
    case "agreed":
      return "Agreed: both sides accepted these terms.";
    case "closed":
      return "Closed. Nothing was agreed.";
    case "expired":
      return "Expired. Nothing was agreed.";
    case "draft":
      return "Not agreed yet. The other side has not opened the invitation.";
  }
  if (r.awaitingYourHuman) return "Not agreed yet. Waiting for your confirmation in Telegram.";
  if (r.youDeclined === "approve") return "Not agreed yet. You tapped Don't on these terms.";
  if (r.youDeclined)
    return `Not agreed yet. You tapped Don't on the ${r.youDeclined}; the room stays open.`;
  return r.yourTurn ? "Not agreed yet. Your turn." : "Not agreed yet. Waiting for the other side.";
}

/** The room as your human should see it: status, the terms, what changed, your limits. */
export function roomCard(r: CardInput): string {
  const lines = [r.with ? `${r.name}, with ${shownText(r.with)}` : r.name, status(r)];
  const terms = termsOnTable(r.history);
  const label = (field: string) => r.schema[field]?.label ?? r.peerSchema?.[field]?.label ?? field;
  if (!terms?.subject) {
    lines.push("No terms on the table yet.");
  } else {
    const by = terms.from_id === r.me ? "you" : "the other side";
    lines.push("", `${r.state === "agreed" ? "Agreed terms" : "Terms on the table"}, from ${by}:`);
    for (const [field, value] of Object.entries(terms.subject)) {
      const type = (r.schema[field] ?? r.peerSchema?.[field])?.type ?? "string";
      lines.push(`- ${label(field)}: ${formatValue(type, value, r.timeZone)}`);
    }
    if (r.theyAccepted && r.state !== "agreed") {
      lines.push("They accepted these terms. Once you confirm, it is agreed.");
    }
    if (r.picked) {
      lines.push(
        "They already stand by these terms, and that is their yes. Once you confirm, it is agreed.",
      );
    }
    if (r.options) {
      lines.push("", "Or one of their other options:");
      for (const option of r.options.slice(1)) {
        const values = Object.entries(option).map(([field, value]) => {
          const type = (r.schema[field] ?? r.peerSchema?.[field])?.type ?? "string";
          return `${label(field)}: ${formatValue(type, value, r.timeZone)}`;
        });
        lines.push(`- ${values.join("; ")}`);
      }
    }
    const tabled = r.history.filter((m) => m.subject);
    const before = tabled[tabled.indexOf(terms) - 1]?.subject;
    if (before) {
      const changed = Object.keys({ ...before, ...terms.subject }).filter(
        (f) => JSON.stringify(before[f]) !== JSON.stringify(terms.subject![f]),
      );
      lines.push(
        changed.length
          ? `Changed from the terms before: ${changed.map(label).join(", ")}.`
          : "The same as the terms before.",
      );
    }
    if (r.outside?.length) {
      lines.push(
        `Outside your limits: ${[...new Set(r.outside.map((b) => label(b.field)))].join(", ")}.`,
      );
    } else if (r.outside) {
      lines.push("Within your limits.");
    }
  }
  if (r.limitsCannotMeet.length) {
    lines.push(
      `Your limits and theirs cannot overlap on ${r.limitsCannotMeet.map(label).join(", ")}: no deal is possible there.`,
    );
  }
  return lines.join("\n");
}

/** How the card is meant to be used, in every result that carries one. */
export const CARD_NOTE =
  "for_your_human is written for your human: show it as it is, translated into their " +
  "language if need be, with every value unchanged. Do not retell the terms in your own words.";
