// The typed half of the protocol (PROTOCOL.md §3). Closed on purpose:
// the state machine hangs off `verdict`, so it does not grow. `subject` does.

export const PROTOCOL_VERSION = 1;

export const VERDICTS = [
  "offer",
  "counter",
  "need_more_detail",
  "approve",
  "reject",
  "cancel",
] as const;

export type Verdict = (typeof VERDICTS)[number];

/** Moves that pass the turn back to the other side without ending the room. */
export const CONTINUING: ReadonlySet<Verdict> = new Set<Verdict>([
  "offer",
  "counter",
  "need_more_detail",
]);

/** Moves only a human can release; the agent's request for one waits for them (§8). */
export const HUMAN_GATED = ["approve", "reject", "cancel"] as const;
export type HumanGatedVerdict = (typeof HUMAN_GATED)[number];

export function isHumanGated(v: Verdict): v is HumanGatedVerdict {
  return (HUMAN_GATED as readonly string[]).includes(v);
}

/** Moves that carry terms, and therefore must carry a subject hash. */
export const CARRIES_TERMS: ReadonlySet<Verdict> = new Set<Verdict>(["offer", "counter"]);

export interface Envelope {
  v: number;
  room: string;
  msg: string;
  from: string;
  round: number;
  verdict: Verdict;
  in_reply_to: string | null;
  subject_hash: string | null;
  deadline: string | null;
  ts: string;
  subject: Record<string, unknown> | null;
}

export function isVerdict(x: unknown): x is Verdict {
  return typeof x === "string" && (VERDICTS as readonly string[]).includes(x);
}

/**
 * Deterministic serialisation for hashing: keys sorted at every level, so two
 * sides hash identical terms identically. Without this `subject_hash` cannot
 * be compared across parties and "we agreed" stays an agent's claim (§3).
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

export async function subjectHash(subject: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalize(subject));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}
