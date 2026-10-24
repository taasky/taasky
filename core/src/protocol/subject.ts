// The free half (PROTOCOL.md §4). The protocol does not know what is being
// negotiated; each party declares the shape of its own subject when it enters
// the room, and that declaration is what the peer validates against and what
// the confirmation card renders from.
//
// Validation is strict: an unknown field rejects the whole message rather than
// being ignored, because an ignored field is a place for text to hide.

export type FieldType = "string" | "int" | "bool" | "timerange" | "enum" | "money" | "date";

export interface FieldDecl {
  type: FieldType;
  /** Shown to a human. Written by the counterparty — render as untrusted (§4.3). */
  label: string;
  optional?: boolean;
  /** `enum` only. */
  values?: string[];
  /** `money` only: fixes the currency (ISO 4217) when the field has one. */
  currency?: string;
  /** `string` only; hard cap regardless. */
  max_len?: number;
  /** Wrap the declared type in an array. */
  repeated?: boolean;
}

export type SubjectSchema = Record<string, FieldDecl>;

const MAX_FIELDS = 24;
const MAX_STRING = 500;
const MAX_ITEMS = 32;

export class SubjectError extends Error {}

function fail(path: string, why: string): never {
  throw new SubjectError(`${path}: ${why}`);
}

export function parseSchema(raw: unknown): SubjectSchema {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    fail("subject_schema", "must be an object of field declarations");
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) fail("subject_schema", "declares no fields");
  if (entries.length > MAX_FIELDS) {
    fail("subject_schema", `declares more than ${MAX_FIELDS} fields`);
  }

  const schema: SubjectSchema = {};
  for (const [name, decl] of entries) {
    const at = `subject_schema.${name}`;
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(name))
      fail(
        at,
        "invalid field name: use a-z, 0-9 and _, starting with a letter, at most 32 characters " +
          '(e.g. "meeting_time"). Put the human wording, in any language, in `label`',
      );
    if (decl === null || typeof decl !== "object") fail(at, "must be an object");

    const d = decl as Record<string, unknown>;
    const type = d.type;
    if (
      type !== "string" &&
      type !== "int" &&
      type !== "bool" &&
      type !== "timerange" &&
      type !== "enum" &&
      type !== "money" &&
      type !== "date"
    ) {
      fail(at, "unknown type");
    }
    if (typeof d.label !== "string" || d.label.length === 0 || d.label.length > 80) {
      fail(at, "label must be a string of 1..80 chars");
    }
    if (type === "enum") {
      if (!Array.isArray(d.values) || d.values.length < 2 || d.values.length > 32) {
        fail(at, "enum needs 2..32 values");
      }
      if (!d.values.every((v) => typeof v === "string" && v.length <= 40)) {
        fail(at, "enum values must be short strings");
      }
    }

    if (d.currency !== undefined && (type !== "money" || !isCurrency(d.currency))) {
      fail(at, "currency is a three-letter ISO 4217 code, for money fields only");
    }

    schema[name] = {
      type,
      label: d.label,
      optional: d.optional === true,
      repeated: d.repeated === true,
      values: type === "enum" ? (d.values as string[]) : undefined,
      currency: type === "money" ? (d.currency as string | undefined) : undefined,
      max_len:
        type === "string"
          ? Math.min(typeof d.max_len === "number" ? d.max_len : MAX_STRING, MAX_STRING)
          : undefined,
    };
  }
  return schema;
}

const isCurrency = (code: unknown): code is string =>
  typeof code === "string" && /^[A-Z]{3}$/.test(code);

/** Digits after the point for a currency: 2 for EUR, 0 for JPY, 3 for KWD. */
export function minorDigits(currency: string): number {
  return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
    .maximumFractionDigits!;
}

/** YYYY-MM-DD that names a real day: no 2026-02-30. */
function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(value);
}

function checkScalar(decl: FieldDecl, value: unknown, at: string): void {
  switch (decl.type) {
    case "string":
      if (typeof value !== "string") fail(at, "expected string");
      if (value.length > (decl.max_len ?? MAX_STRING)) fail(at, "string too long");
      return;
    case "int":
      if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        fail(at, "expected integer");
      }
      return;
    case "bool":
      if (typeof value !== "boolean") fail(at, "expected boolean");
      return;
    case "enum":
      if (typeof value !== "string" || !decl.values!.includes(value)) {
        fail(at, "value outside declared set");
      }
      return;
    case "date":
      if (!isDate(value)) fail(at, "expected a date, YYYY-MM-DD");
      return;
    case "money": {
      // Amount as a decimal string, so no float ever stands between the
      // number an agent meant and the one a human confirms.
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        fail(at, "expected {amount, currency}");
      }
      const keys = Object.keys(value as object);
      if (keys.length !== 2 || !keys.includes("amount") || !keys.includes("currency")) {
        fail(at, "money takes exactly amount and currency");
      }
      const { amount, currency } = value as { amount: unknown; currency: unknown };
      if (!isCurrency(currency)) fail(at, "currency must be a three-letter ISO 4217 code");
      if (decl.currency && currency !== decl.currency)
        fail(at, `currency must be ${decl.currency}`);
      const digits = minorDigits(currency);
      const shape = digits ? `^\\d{1,15}(\\.\\d{1,${digits}})?$` : "^\\d{1,15}$";
      if (typeof amount !== "string" || !new RegExp(shape).test(amount)) {
        fail(at, `amount must be a decimal string with at most ${digits} digits after the point`);
      }
      return;
    }
    case "timerange": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        fail(at, "expected {start, end}");
      }
      const keys = Object.keys(value as object);
      if (keys.length !== 2 || !keys.includes("start") || !keys.includes("end")) {
        fail(at, "timerange takes exactly start and end");
      }
      const { start, end } = value as { start: unknown; end: unknown };
      const s = typeof start === "string" ? Date.parse(start) : NaN;
      const e = typeof end === "string" ? Date.parse(end) : NaN;
      if (Number.isNaN(s) || Number.isNaN(e)) fail(at, "start/end must be RFC3339");
      if (e <= s) fail(at, "end must follow start");
      return;
    }
  }
}

/** Validates a subject against a declared schema. Throws on the first problem. */
export function validateSubject(schema: SubjectSchema, subject: unknown): Record<string, unknown> {
  if (subject === null || typeof subject !== "object" || Array.isArray(subject)) {
    fail("subject", "must be an object");
  }
  const value = subject as Record<string, unknown>;

  for (const key of Object.keys(value)) {
    if (!(key in schema)) fail(`subject.${key}`, "not in the declared schema");
  }

  for (const [name, decl] of Object.entries(schema)) {
    const at = `subject.${name}`;
    const v = value[name];
    if (v === undefined || v === null) {
      if (!decl.optional) fail(at, "required field missing");
      continue;
    }
    if (decl.repeated) {
      if (!Array.isArray(v)) fail(at, "expected an array");
      if (v.length === 0) fail(at, "array is empty");
      if (v.length > MAX_ITEMS) fail(at, `more than ${MAX_ITEMS} items`);
      for (const [i, item] of v.entries()) checkScalar(decl, item, `${at}[${i}]`);
    } else {
      checkScalar(decl, v, at);
    }
  }
  return value;
}
