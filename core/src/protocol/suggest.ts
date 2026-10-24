// The counter closest to the other side's terms that the human's limits allow:
// their value where it is inside the limits, the nearest bound where it is not.
// negotiation_read offers it as a ready call, because weaker models read "counter
// now" and then report "your turn" to their human instead of moving. The agent
// still sends it, or not; nothing is sent from here.

import { checkLimits, type FieldLimit, type Limits } from "./limits.js";
import { type FieldType, type SubjectSchema, validateSubject } from "./subject.js";

const currencyOf = (v: unknown) => (v as { currency?: string } | undefined)?.currency;

function milli(amount: string): bigint {
  const [whole, frac = ""] = amount.split(".");
  return BigInt(whole! + frac.padEnd(3, "0"));
}

function below(type: FieldType, a: unknown, b: unknown): boolean {
  if (type === "money") {
    return milli((a as { amount: string }).amount) < milli((b as { amount: string }).amount);
  }
  if (type === "int") return (a as number) < (b as number);
  return (a as string) < (b as string);
}

/** `ms` as RFC3339 in the UTC offset of `like`, so the counter reads in the human's own time. */
function inOffsetOf(ms: number, like: string): string {
  const m = /([+-])(\d{2}):?(\d{2})$/.exec(like);
  const off = m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  const local = new Date(ms + off * 60_000).toISOString().slice(0, 19);
  return m ? `${local}${m[1]}${m[2]}:${m[3]}` : `${local}Z`;
}

/** One value moved inside its limit, or undefined when there is no honest way to. */
function within(type: FieldType, limit: FieldLimit, value: unknown): unknown {
  switch (type) {
    case "enum":
      return limit.one_of && !limit.one_of.includes(value as string) ? limit.one_of[0] : value;
    case "bool":
      return limit.equals ?? value;
    case "timerange": {
      const { start, end } = value as { start: string; end: string };
      let s = Date.parse(start);
      let e = Date.parse(end);
      const length = e - s;
      const min = limit.min === undefined ? undefined : Date.parse(limit.min as string);
      const max = limit.max === undefined ? undefined : Date.parse(limit.max as string);
      // Keep their length, slide into the window; shorten only if the window is shorter.
      if (max !== undefined && e > max) [s, e] = [max - length, max];
      if (min !== undefined && s < min) [s, e] = [min, min + length];
      if (max !== undefined && e > max) e = max;
      if (s === Date.parse(start) && e === Date.parse(end)) return value;
      const like = (limit.max ?? limit.min) as string;
      return { start: inOffsetOf(s, like), end: inOffsetOf(e, like) };
    }
    case "money":
    case "int":
    case "date":
      if (
        type === "money" &&
        [limit.min, limit.max].some((b) => b !== undefined && currencyOf(b) !== currencyOf(value))
      ) {
        return undefined;
      }
      if (limit.min !== undefined && below(type, value, limit.min)) return limit.min;
      if (limit.max !== undefined && below(type, limit.max, value)) return limit.max;
      return value;
    default:
      return value;
  }
}

/**
 * Their terms, moved inside your limits, in your schema's shape. Null when
 * they are already inside, or when no such counter can be made honestly:
 * a field of yours they did not fill, a repeated field, another currency.
 */
export function counterWithin(
  schema: SubjectSchema,
  limits: Limits | null,
  subject: Record<string, unknown>,
  subjectSchema: SubjectSchema,
): Record<string, unknown> | null {
  if (!limits || checkLimits(schema, limits, subject, subjectSchema).length === 0) return null;
  const out: Record<string, unknown> = {};
  for (const [field, decl] of Object.entries(schema)) {
    const theirs = subjectSchema[field]?.type === decl.type ? subject[field] : undefined;
    if (theirs === undefined || theirs === null) {
      if (!decl.optional) return null;
      continue;
    }
    const limit = limits[field];
    if (!limit) {
      out[field] = theirs;
      continue;
    }
    if (decl.repeated) return null;
    const v = within(decl.type, limit, theirs);
    if (v === undefined) return null;
    out[field] = v;
  }
  try {
    validateSubject(schema, out);
  } catch {
    return null;
  }
  return checkLimits(schema, limits, out).length === 0 ? out : null;
}
