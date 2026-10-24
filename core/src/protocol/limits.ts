// Private limits (PROTOCOL.md §7): the bounds a party's human set — the most
// they pay, the earliest they can meet. Only the relay sees them; the other
// side never does. They do three things the agents cannot be trusted with,
// because an agent tuned to be agreeable drifts toward any deal:
//
//  - an agent's own offer outside its limits is refused before it is sent;
//  - terms outside them are flagged on the human's confirmation card;
//  - when both sides set limits on the same field and they cannot meet, both
//    are told so — without either number — instead of circling forever.
//
// Limits are set once, on open or join, and never change: a party that could
// move its limit and ask again could find the other's number one bit at a time.

import {
  type FieldDecl,
  type FieldType,
  minorDigits,
  SubjectError,
  type SubjectSchema,
} from "./subject.js";

export interface FieldLimit {
  /** int: integer; money: {amount, currency}; date: YYYY-MM-DD; timerange: RFC3339, no start before it. */
  min?: unknown;
  /** As min; timerange: no end after it. */
  max?: unknown;
  /** enum: the values that are acceptable. */
  one_of?: string[];
  /** bool: the only acceptable value. */
  equals?: boolean;
}

export type Limits = Record<string, FieldLimit>;

/** One way a value falls outside a limit. `bound` is shaped like the field's values. */
export interface Breach {
  field: string;
  rule: "below_min" | "above_max" | "not_allowed" | "not_equal" | "other_currency";
  bound: unknown;
}

function fail(path: string, why: string): never {
  throw new SubjectError(`${path}: ${why}`);
}

const isDate = (v: unknown): v is string =>
  typeof v === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);

/** A money amount as an integer count of thousandths, so no float decides a comparison. */
function milli(amount: string): bigint {
  const [whole, frac = ""] = amount.split(".");
  return BigInt(whole! + frac.padEnd(3, "0"));
}

function parseBound(decl: FieldDecl, value: unknown, at: string): unknown {
  switch (decl.type) {
    case "int":
      if (typeof value !== "number" || !Number.isSafeInteger(value)) fail(at, "expected integer");
      return value;
    case "date":
      if (!isDate(value)) fail(at, "expected a date, YYYY-MM-DD");
      return value;
    case "timerange":
      if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
        fail(at, "expected an RFC3339 time");
      }
      return value;
    case "money": {
      const m = value as { amount?: unknown; currency?: unknown } | null;
      if (!m || typeof m !== "object" || typeof m.currency !== "string") {
        fail(at, "expected {amount, currency}");
      }
      if (!/^[A-Z]{3}$/.test(m.currency)) fail(at, "currency must be ISO 4217");
      if (decl.currency && m.currency !== decl.currency)
        fail(at, `currency must be ${decl.currency}`);
      const digits = minorDigits(m.currency);
      const shape = digits ? `^\\d{1,15}(\\.\\d{1,${digits}})?$` : "^\\d{1,15}$";
      if (typeof m.amount !== "string" || !new RegExp(shape).test(m.amount)) {
        fail(at, "amount must be a decimal string");
      }
      return { amount: m.amount, currency: m.currency };
    }
    default:
      fail(at, `min and max do not apply to ${decl.type} fields`);
  }
}

/** -1, 0 or 1. Money bounds of different currencies never get here. */
function compare(type: FieldType, a: unknown, b: unknown): number {
  let d: number | bigint;
  if (type === "money") {
    d = milli((a as { amount: string }).amount) - milli((b as { amount: string }).amount);
  } else if (type === "timerange") d = Date.parse(a as string) - Date.parse(b as string);
  else if (type === "int") d = (a as number) - (b as number);
  else d = (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0;
  return d > 0 ? 1 : d < 0 ? -1 : 0;
}

const currencyOf = (v: unknown) => (v as { currency?: string } | undefined)?.currency;

/** Validates limits against the party's own schema. Unknown fields and loose shapes are refused. */
export function parseLimits(schema: SubjectSchema, raw: unknown): Limits | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) fail("limits", "must be an object by field");
  const limits: Limits = {};
  for (const [field, value] of Object.entries(raw as Record<string, unknown>)) {
    const at = `limits.${field}`;
    const decl = schema[field];
    if (!decl) fail(at, "not a field of your subject_schema");
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      fail(at, "must be an object");
    }
    const v = value as Record<string, unknown>;
    const keys = Object.keys(v);
    const allowed =
      decl.type === "enum" ? ["one_of"] : decl.type === "bool" ? ["equals"] : ["min", "max"];
    if (decl.type === "string") fail(at, "string fields take no limits");
    if (keys.length === 0 || !keys.every((k) => allowed.includes(k))) {
      fail(at, `${decl.type} fields take ${allowed.join(" and/or ")}`);
    }

    const limit: FieldLimit = {};
    if (decl.type === "enum") {
      const one = v.one_of;
      if (!Array.isArray(one) || one.length === 0 || !one.every((x) => decl.values!.includes(x))) {
        fail(at, "one_of must list values of the field");
      }
      limit.one_of = [...new Set(one as string[])];
    } else if (decl.type === "bool") {
      if (typeof v.equals !== "boolean") fail(at, "equals must be true or false");
      limit.equals = v.equals;
    } else {
      if ("min" in v) limit.min = parseBound(decl, v.min, `${at}.min`);
      if ("max" in v) limit.max = parseBound(decl, v.max, `${at}.max`);
      if (limit.min !== undefined && limit.max !== undefined) {
        if (decl.type === "money" && currencyOf(limit.min) !== currencyOf(limit.max)) {
          fail(at, "min and max must be in the same currency");
        }
        if (compare(decl.type, limit.min, limit.max) > 0) fail(at, "min is above max");
      }
    }
    limits[field] = limit;
  }
  return Object.keys(limits).length ? limits : null;
}

function breachesOf(type: FieldType, field: string, limit: FieldLimit, value: unknown): Breach[] {
  if (Array.isArray(value)) return value.flatMap((v) => breachesOf(type, field, limit, v));
  if (type === "enum") {
    return limit.one_of && !limit.one_of.includes(value as string)
      ? [{ field, rule: "not_allowed", bound: limit.one_of }]
      : [];
  }
  if (type === "bool") {
    return limit.equals !== undefined && value !== limit.equals
      ? [{ field, rule: "not_equal", bound: limit.equals }]
      : [];
  }
  const out: Breach[] = [];
  const bound = limit.min ?? limit.max;
  if (type === "money" && bound !== undefined && currencyOf(bound) !== currencyOf(value)) {
    return [{ field, rule: "other_currency", bound }];
  }
  // A meeting must lie inside the window: its start no earlier than min,
  // its end no later than max.
  const low = type === "timerange" ? (value as { start: string }).start : value;
  const high = type === "timerange" ? (value as { end: string }).end : value;
  if (limit.min !== undefined && compare(type, low, limit.min) < 0) {
    out.push({ field, rule: "below_min", bound: limit.min });
  }
  if (limit.max !== undefined && compare(type, high, limit.max) > 0) {
    out.push({ field, rule: "above_max", bound: limit.max });
  }
  return out;
}

/**
 * Where `subject` falls outside `limits`. `subject` may be in the other
 * party's shape: a field is checked only where both declare it with the same
 * type, since that is the only case where "the same field" means anything.
 */
export function checkLimits(
  schema: SubjectSchema,
  limits: Limits | null,
  subject: Record<string, unknown>,
  subjectSchema: SubjectSchema = schema,
): Breach[] {
  if (!limits) return [];
  return Object.entries(limits).flatMap(([field, limit]) => {
    const value = subject[field];
    const type = schema[field]?.type;
    if (value === undefined || value === null || !type || subjectSchema[field]?.type !== type) {
      return [];
    }
    return breachesOf(type, field, limit, value);
  });
}

/**
 * The fields on which two parties' limits cannot both be met — empty when
 * they can, or when nobody limited the same field. Answers yes or no per
 * field and never says by how much: that is all either side learns.
 */
export function cannotMeet(
  a: { schema: SubjectSchema; limits: Limits | null },
  b: { schema: SubjectSchema; limits: Limits | null },
): string[] {
  if (!a.limits || !b.limits) return [];
  const fields: string[] = [];
  for (const [field, la] of Object.entries(a.limits)) {
    const lb = b.limits[field];
    const type = a.schema[field]?.type;
    if (!lb || !type || b.schema[field]?.type !== type) continue;

    let apart = false;
    if (type === "enum") {
      apart = !!la.one_of && !!lb.one_of && !la.one_of.some((v) => lb.one_of!.includes(v));
    } else if (type === "bool") {
      apart = la.equals !== undefined && lb.equals !== undefined && la.equals !== lb.equals;
    } else {
      const bounds = [la.min, la.max, lb.min, lb.max].filter((x) => x !== undefined);
      // Amounts in two currencies are not comparable; say nothing rather than guess.
      if (type === "money" && new Set(bounds.map(currencyOf)).size > 1) continue;
      const pick = (x: unknown, y: unknown, sign: 1 | -1) =>
        x === undefined ? y : y === undefined ? x : compare(type, x, y) * sign >= 0 ? x : y;
      const low = pick(la.min, lb.min, 1);
      const high = pick(la.max, lb.max, -1);
      if (low !== undefined && high !== undefined) {
        const c = compare(type, low, high);
        // A meeting needs time between start and end, so an exact touch is no window.
        apart = type === "timerange" ? c >= 0 : c > 0;
      }
    }
    if (apart) fields.push(field);
  }
  return fields;
}
