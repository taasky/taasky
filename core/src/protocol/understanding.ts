// A shared understanding (PROTOCOL.md §8.1): two sides edit one list of
// findings until they agree on it or know where they differ. Such a room
// commits no one to anything, so nothing in it waits for a human's yes.
//
// It is recognised by its shape, not by a flag: a room is one when every
// party declared exactly these fields, all free text. Nothing that binds
// (a price, a time, a date) fits in it.

import type { SubjectSchema } from "./subject.js";

/** The common-ground room, with English labels; an agent may relabel it in its human's language. */
export const COMMON_GROUND_SCHEMA: SubjectSchema = {
  topic: { type: "string", label: "Topic" },
  sides: { type: "string", label: "Who's talking", repeated: true },
  findings: { type: "string", label: "Findings", repeated: true },
  conclusion: { type: "string", label: "Conclusion", optional: true },
  next_steps: { type: "string", label: "Next steps", optional: true, repeated: true },
};

/** Whether `schema` is the common-ground shape: the same fields and types, any labels. */
export function isUnderstanding(schema: SubjectSchema): boolean {
  const fields = Object.keys(schema);
  const shape = Object.entries(COMMON_GROUND_SCHEMA);
  if (fields.length !== shape.length) return false;
  return shape.every(([name, want]) => {
    const got = schema[name];
    return (
      got !== undefined &&
      got.type === "string" &&
      !!got.repeated === !!want.repeated &&
      !!got.optional === !!want.optional
    );
  });
}

/**
 * Each finding status and how a person reads it: as a chip on the page, a tag
 * in Telegram, a count, a heading in Markdown. In reading order: where the
 * sides still differ first.
 */
export const FINDING_STATUS = {
  disputed: { chip: "differ", tag: "disputed", count: "disputed", title: "Disputed" },
  open: { chip: "open", tag: "you differ", count: "open", title: "Open: we differ" },
  proposed: { chip: "proposed", tag: "not answered", count: "proposed", title: "Not yet answered" },
  "agreed-except": {
    chip: "agreed, except",
    tag: "except a part",
    count: "agreed with an exception",
    title: "Agreed, with an exception",
  },
  agreed: { chip: "agreed", tag: "", count: "agreed", title: "Agreed" },
};
export type FindingStatus = keyof typeof FINDING_STATUS;
export const FINDING_STATUSES = Object.keys(FINDING_STATUS) as FindingStatus[];

/**
 * One finding: "F3 · disputed · seen · claim: reason; crux: question". The
 * basis is optional, and so are the closing "; except: ..." (the part an
 * agreed-except leaves out) and "; crux: ..." (what would settle a dispute).
 */
export interface Finding {
  n: string;
  status: FindingStatus;
  basis: string | null;
  /** Everything after the status and basis, as written. */
  text: string;
  claim: string;
  reason: string;
  except: string | null;
  crux: string | null;
}

/** The closing notes a finding may carry, and how a person reads them. */
export const FINDING_NOTES = { except: "Except", crux: "Turns on" } as const;
const NOTE = /;\s*(except|crux):\s*/i;

// Longest status first, so "agreed" doesn't stop short of "agreed-except".
const FINDING = new RegExp(
  `^F(\\d+)\\s*·\\s*(${[...FINDING_STATUSES].sort((a, b) => b.length - a.length).join("|")})` +
    "\\s*·\\s*(?:(seen|checked|told)\\s*·\\s*)?([\\s\\S]*)$",
  "i",
);

/** A finding line split into its parts; null if it doesn't follow the form. */
export function readFinding(item: unknown): Finding | null {
  const m = FINDING.exec(String(item).trim());
  if (!m) return null;
  const text = m[4]!.trim();
  // "; except: ..." and "; crux: ..." close the line, in either order.
  const [body, ...rest] = text.split(NOTE);
  const notes: Record<string, string> = {};
  for (let i = 0; i + 1 < rest.length; i += 2) notes[rest[i]!.toLowerCase()] = rest[i + 1]!.trim();
  const head = body!.trim();
  // The reason or evidence comes after the last colon (the skill's form).
  const cut = head.lastIndexOf(": ");
  return {
    n: m[1]!,
    status: m[2]!.toLowerCase() as FindingStatus,
    basis: m[3]?.toLowerCase() ?? null,
    text,
    claim: cut > 0 ? head.slice(0, cut) : head,
    reason: cut > 0 ? head.slice(cut + 2) : "",
    except: notes.except || null,
    crux: notes.crux || null,
  };
}

/** A finding's closing notes that it has, labelled for a person: [["Except", "lodash"]]. */
export function findingNotes(f: Finding): [string, string][] {
  return (Object.keys(FINDING_NOTES) as (keyof typeof FINDING_NOTES)[]).flatMap((k) =>
    f[k] ? [[FINDING_NOTES[k], f[k]] as [string, string]] : [],
  );
}

const ROOM_STATE: Record<string, string> = {
  agreed: "Agreed by both sides.",
  awaiting: "Still being worked out.",
  draft: "Still being worked out.",
};

/** A room every party of which declared the common-ground shape. */
export function isUnderstandingRoom(parties: { subject_schema: SubjectSchema }[]): boolean {
  return parties.length > 0 && parties.every((p) => isUnderstanding(p.subject_schema));
}

/**
 * The list as Markdown, to paste into a PR, an issue or notes: conclusion,
 * then findings grouped by status, then next steps. Findings that don't follow
 * the "F1 · status · claim" form are listed as they are.
 */
export function understandingMarkdown(subject: Record<string, unknown>, state: string): string {
  const strings = (v: unknown) =>
    (Array.isArray(v) ? v : [v]).filter((s): s is string => typeof s === "string" && s !== "");
  const out: string[] = [`# ${strings(subject.topic)[0] ?? "Shared understanding"}`, ""];
  out.push(`_${ROOM_STATE[state] ?? "Ended without an agreed list."}_`, "");
  const sides = strings(subject.sides);
  if (sides.length) out.push(...sides.map((s) => `- ${s}`), "");
  const conclusion = strings(subject.conclusion)[0];
  if (conclusion) out.push(`**Conclusion:** ${conclusion}`, "");

  // A record reads outcome first, unlike the page, which leads with what is left to settle.
  const order: string[] = ["agreed", "agreed-except", "disputed", "open", "proposed"];
  const groups = new Map<string, string[]>();
  for (const item of strings(subject.findings)) {
    const f = readFinding(item);
    const key = f ? f.status : "other";
    const line = f
      ? [
          `**F${f.n}** ${f.basis ? `_(${f.basis})_ ` : ""}${f.claim}${f.reason ? `: ${f.reason}` : ""}`,
          ...findingNotes(f).map(([label, note]) => `  - ${label}: ${note}`),
        ].join("\n")
      : item;
    groups.set(key, [...(groups.get(key) ?? []), line]);
  }
  for (const key of [...order, "other"]) {
    const items = groups.get(key);
    const title = FINDING_STATUS[key as FindingStatus]?.title ?? "Findings";
    if (items?.length) out.push(`## ${title}`, "", ...items.map((i) => `- ${i}`), "");
  }
  const steps = strings(subject.next_steps);
  if (steps.length) out.push("## Next steps", "", ...steps.map((s) => `- ${s}`), "");
  return `${out.join("\n").trimEnd()}\n`;
}
