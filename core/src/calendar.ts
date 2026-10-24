// An agreed deal as a calendar event: an .ics file for Apple Calendar and
// Outlook, a link for Google Calendar. Only when the terms say when: one
// time range, or else one date (all day). Several times on the table, or a
// field that repeats, say no single when, so there is no event.

import { formatValue } from "./card.js";
import type { MessageRow, Participant, Shown } from "./db.js";
import { roomName } from "./names.js";
import { termsOnTable } from "./protocol/move.js";
import type { RoomState } from "./protocol/state.js";
import type { SubjectSchema } from "./protocol/subject.js";

export interface CalendarEvent {
  /** Stable per room, so adding it twice updates rather than duplicates. */
  uid: string;
  title: string;
  /** RFC3339 with an offset; for an all-day event, YYYY-MM-DD. */
  start: string;
  /** Exclusive end; for an all-day event, the next day. */
  end: string;
  allDay: boolean;
  location: string | null;
  description: string;
  url: string;
}

/** A field that names a place, by its name or its label. */
const PLACE = /\b(place|address|venue|location|where)\b/i;

export function eventOf(
  schema: SubjectSchema,
  subject: Record<string, unknown>,
  opts: { roomId: string; title: string; url: string },
): CalendarEvent | null {
  const fields = Object.entries(schema).filter(([f]) => subject[f] !== undefined);
  const single = (type: string) => fields.filter(([, d]) => d.type === type && !d.repeated);
  const ranges = single("timerange");
  const dates = single("date");

  let start: string;
  let end: string;
  let allDay = false;
  if (ranges.length === 1) {
    const value = subject[ranges[0]![0]] as { start: string; end: string };
    ({ start, end } = value);
  } else if (ranges.length === 0 && dates.length === 1) {
    start = subject[dates[0]![0]] as string;
    end = nextDay(start);
    allDay = true;
  } else {
    return null;
  }

  const place = fields.find(
    ([f, d]) =>
      (d.type === "string" || d.type === "enum") &&
      !d.repeated &&
      (PLACE.test(f) || PLACE.test(d.label)),
  );
  const description = [
    ...fields.map(([f, d]) => `${d.label}: ${formatValue(d.type, subject[f])}`),
    "",
    `Agreed in Taasky: ${opts.url}`,
  ].join("\n");

  return {
    uid: `${opts.roomId}@taasky.ai`,
    title: opts.title,
    start,
    end,
    allDay,
    location: place ? String(subject[place[0]]) : null,
    description,
    url: opts.url,
  };
}

/**
 * The event for an agreed room, as `url`'s holder sees it: titled with the
 * other side's name when they show one. Null until agreed, or without a when.
 */
export function agreedEvent(r: {
  roomId: string;
  state: RoomState;
  history: readonly MessageRow[];
  parties: readonly Participant[];
  them: Shown | null;
  url: string;
}): CalendarEvent | null {
  if (r.state !== "agreed") return null;
  const terms = termsOnTable(r.history);
  const author = terms && r.parties.find((p) => p.id === terms.from_id);
  if (!terms?.subject || !author) return null;
  const title = `${r.them ? `With ${r.them.name}` : roomName(r.roomId).name} · Taasky`;
  return eventOf(author.subject_schema, terms.subject, { roomId: r.roomId, title, url: r.url });
}

function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** 20261023T070000Z, or 20261023 for a day. */
const stamp = (value: string, allDay: boolean) =>
  allDay
    ? value.replaceAll("-", "")
    : `${new Date(value).toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`;

/** RFC 5545 text: backslash, semicolon, comma and newline escaped. */
const text = (s: string) => s.replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\r?\n/g, "\\n");

/** Lines longer than 75 octets continue on the next, after a space. */
function fold(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let chunk = "";
  let size = 0;
  for (const ch of line) {
    const n = new TextEncoder().encode(ch).length;
    if (size + n > (out.length ? 74 : 75)) {
      out.push(chunk);
      chunk = "";
      size = 0;
    }
    chunk += ch;
    size += n;
  }
  out.push(chunk);
  return out.join("\r\n ");
}

export function icsFile(e: CalendarEvent, now: Date): string {
  const when = e.allDay
    ? [`DTSTART;VALUE=DATE:${stamp(e.start, true)}`, `DTEND;VALUE=DATE:${stamp(e.end, true)}`]
    : [`DTSTART:${stamp(e.start, false)}`, `DTEND:${stamp(e.end, false)}`];
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Taasky//Agreed deal//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${e.uid}`,
    `DTSTAMP:${stamp(now.toISOString(), false)}`,
    ...when,
    `SUMMARY:${text(e.title)}`,
    ...(e.location ? [`LOCATION:${text(e.location)}`] : []),
    `DESCRIPTION:${text(e.description)}`,
    `URL:${e.url}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ]
    .map(fold)
    .join("\r\n")
    .concat("\r\n");
}

export function googleCalendarUrl(e: CalendarEvent): string {
  const q = new URLSearchParams({
    action: "TEMPLATE",
    text: e.title,
    dates: `${stamp(e.start, e.allDay)}/${stamp(e.end, e.allDay)}`,
    details: e.description,
  });
  if (e.location) q.set("location", e.location);
  return `https://calendar.google.com/calendar/render?${q}`;
}
