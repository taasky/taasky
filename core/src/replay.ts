// How a deal came together, in a line: where it started, where it landed,
// how many moves and how long. Only moves both sides saw; limits never
// appear. The Telegram card and the room page format the values their way.

import type { MessageRow, Participant } from "./db.js";
import { CARRIES_TERMS, type Verdict } from "./protocol/envelope.js";
import { termsOnTable } from "./protocol/move.js";
import type { FieldType } from "./protocol/subject.js";

/** A value as the caller shows it, already safe for where it goes (HTML). */
export type ShowValue = (type: FieldType, value: unknown) => string;

export interface ReplayInput {
  history: readonly MessageRow[];
  parties: readonly Participant[];
  /** The reader's participant id. */
  me: string;
  /** The reader negotiated through an agent, so "your agent" made their moves. */
  agent: boolean;
}

/** One field, the first that changed (usually the time), so the line stays a line. */
const MAX_FIELDS = 1;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * "They first asked for Tue 14:00 – 16:00. Agreed on Thu 9:00 – 11:00." Null
 * when there were no terms to tell about.
 */
export function replayStory(r: ReplayInput, show: ShowValue): string | null {
  const first = r.history.find((m) => CARRIES_TERMS.has(m.verdict as Verdict) && m.subject);
  const final = termsOnTable(r.history);
  if (!first?.subject || !final?.subject) return null;
  const author = r.parties.find((p) => p.id === final.from_id);
  if (!author) return null;

  const mine = first.from_id === r.me;
  const whose = mine ? (r.agent ? "your agent's" : "your") : "their";
  const changed = Object.entries(author.subject_schema)
    .filter(([f]) => first.subject![f] !== undefined && final.subject![f] !== undefined)
    .filter(([f]) => !same(first.subject![f], final.subject![f]))
    .slice(0, MAX_FIELDS);
  if (!changed.length) return `Agreed on ${whose} first terms.`;

  const list = (s: Record<string, unknown>) =>
    changed.map(([f, d]) => show(d.type, s[f])).join(", ");
  const who = mine ? (r.agent ? "Your agent" : "You") : "They";
  const verb = mine ? "first proposed" : "first asked for";
  return `${who} ${verb} ${list(first.subject)}. Agreed on ${list(final.subject)}.`;
}

/** "5 steps, 3 minutes": from the first step to the last. */
export function replayPace(history: readonly MessageRow[]): string | null {
  if (!history.length) return null;
  const n = history.length;
  const ms = Date.parse(history.at(-1)!.ts) - Date.parse(history[0]!.ts);
  return `${n} ${n === 1 ? "step" : "steps"}, ${duration(ms)}`;
}

export function duration(ms: number): string {
  if (ms < 60_000) return "under a minute";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  const days = Math.round(hours / 24);
  return `${days} days`;
}
