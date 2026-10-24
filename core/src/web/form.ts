// Terms as an HTML form, and back. The form is built from the party's own
// declared schema (§4), so a person without an agent can state terms in the
// same typed shape an agent would. The result still goes through
// validateSubject in planMove; this only turns form strings into types.
//
// Field names: `f.<field>` for a single value, `f.<field>.<i>` for each item
// of a repeated one, then `.start` / `.end` for a timerange and `.amount` /
// `.currency` for money.
// Timeranges travel as RFC3339 in hidden inputs that a small script fills
// from the visible datetime-local ones, in the browser's own time zone.

import { escapeHtml } from "../html.js";
import { type FieldDecl, SubjectError, type SubjectSchema } from "../protocol/subject.js";

const MAX_ITEMS = 32;

function scalarInput(name: string, decl: FieldDecl, value: unknown): string {
  const v = value === undefined || value === null ? "" : value;
  const req = decl.optional || decl.repeated ? "" : " required";
  switch (decl.type) {
    case "string":
      return `<input name="${name}" value="${escapeHtml(String(v))}" maxlength="${decl.max_len ?? 500}"${req}>`;
    case "int":
      return `<input name="${name}" type="number" step="1" value="${escapeHtml(String(v))}"${req}>`;
    case "bool": {
      const opt = (val: string, text: string, on: boolean) =>
        `<option value="${val}"${on ? " selected" : ""}>${text}</option>`;
      return `<select name="${name}"${req}>${opt("", "—", v === "")}${opt("yes", "Yes", v === true)}${opt("no", "No", v === false)}</select>`;
    }
    case "enum":
      return `<select name="${name}"${req}><option value="">—</option>${decl
        .values!.map(
          (e) =>
            `<option value="${escapeHtml(e)}"${e === v ? " selected" : ""}>${escapeHtml(e)}</option>`,
        )
        .join("")}</select>`;
    case "date":
      return `<input name="${name}" type="date" value="${escapeHtml(String(v))}"${req}>`;
    case "money": {
      const money = (v || {}) as { amount?: string; currency?: string };
      const amount = `<label>Amount<input name="${name}.amount" inputmode="decimal" value="${escapeHtml(money.amount ?? "")}"${req}></label>`;
      // A fixed currency is part of the declaration, so the person only names the amount.
      const currency = decl.currency
        ? `<label>Currency<input value="${escapeHtml(decl.currency)}" disabled><input type="hidden" name="${name}.currency" value="${escapeHtml(decl.currency)}"></label>`
        : `<label>Currency<input name="${name}.currency" value="${escapeHtml(money.currency ?? "")}" maxlength="3" placeholder="EUR" autocapitalize="characters"${req}></label>`;
      return `<div class="row">${amount}${currency}</div>`;
    }
    case "timerange": {
      const range = (v || {}) as { start?: string; end?: string };
      const half = (part: "start" | "end", text: string) =>
        `<label>${text}<input type="datetime-local" data-for="${name}.${part}"${req}>` +
        `<input type="hidden" name="${name}.${part}" value="${escapeHtml(range[part] ?? "")}"></label>`;
      return `<div class="row">${half("start", "From")}${half("end", "To")}</div>`;
    }
  }
}

/** Inputs for every field of `schema`, filled from `prefill` (usually the terms on the table). */
export function renderFields(schema: SubjectSchema, prefill: Record<string, unknown> = {}): string {
  return Object.entries(schema)
    .map(([field, decl]) => {
      const label = `${escapeHtml(decl.label)}${decl.optional ? " <small>(optional)</small>" : ""}`;
      const base = `f.${field}`;
      if (!decl.repeated)
        return `<label>${label}${scalarInput(base, decl, prefill[field])}</label>`;
      const items = Array.isArray(prefill[field]) ? (prefill[field] as unknown[]) : [];
      // One spare row to add an item; empty rows are dropped on submit.
      const rows = [...items, undefined]
        .slice(0, MAX_ITEMS)
        .map((item, i) => scalarInput(`${base}.${i}`, decl, item));
      return `<fieldset style="border:0;padding:0;margin:0;display:grid;gap:.4rem"><legend>${label}</legend>${rows.join("")}</fieldset>`;
    })
    .join("\n");
}

/** Fills the hidden RFC3339 inputs from the visible local-time ones, both ways. */
// Moving the start carries the end along, keeping the length: people change
// "when", rarely "how long", and an end left behind the start was refused
// with the form reset. An end before its start is flagged before sending.
// A function, so a room page that swaps in a new form can run it again.
export const TIMERANGE_SCRIPT = `<script>
window.timeranges = (root) => {
  const pad = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  for (const local of root.querySelectorAll("input[data-for]")) {
    const iso = local.form.elements[local.dataset.for];
    if (iso.value) local.value = pad(new Date(iso.value));
    local.addEventListener("input", () => {
      iso.value = local.value ? new Date(local.value).toISOString() : "";
    });
  }
  for (const start of root.querySelectorAll('input[data-for$=".start"]')) {
    const end = start.form.querySelector('input[data-for="' + start.dataset.for.replace(/\\.start$/, ".end") + '"]');
    if (!end) continue;
    let was = start.value;
    const check = () =>
      end.setCustomValidity(start.value && end.value && end.value <= start.value ? "Must be after the start." : "");
    start.addEventListener("change", () => {
      if (was && start.value && end.value) {
        const moved = new Date(new Date(end.value).getTime() + (new Date(start.value) - new Date(was)));
        end.value = pad(moved);
        end.dispatchEvent(new Event("input"));
      }
      was = start.value;
      check();
    });
    end.addEventListener("input", check);
  }
};
timeranges(document);
</script>`;

function parseScalar(decl: FieldDecl, form: FormData, name: string): unknown {
  if (decl.type === "timerange") {
    const start = String(form.get(`${name}.start`) ?? "");
    const end = String(form.get(`${name}.end`) ?? "");
    if (!start && !end) return undefined;
    if (!start || !end) throw new SubjectError(`${decl.label}: give both start and end`);
    return { start, end };
  }
  if (decl.type === "money") {
    let amount = String(form.get(`${name}.amount`) ?? "").replace(/[\s\u00a0']/g, "");
    // "1 500,00", "1.500,00" and "1,500.00" all mean what a person thinks they
    // mean. A lone comma before exactly three digits groups thousands.
    if (amount.lastIndexOf(",") > amount.lastIndexOf(".") && !/,\d{3}$/.test(amount)) {
      amount = amount.replace(/\./g, "").replace(",", ".");
    } else {
      amount = amount.replace(/,/g, "");
    }
    const currency = String(form.get(`${name}.currency`) ?? "")
      .trim()
      .toUpperCase();
    if (!amount && (!currency || decl.currency)) return undefined;
    if (!amount || !currency)
      throw new SubjectError(`${decl.label}: give both amount and currency`);
    return { amount, currency };
  }
  const raw = String(form.get(name) ?? "").trim();
  if (raw === "") return undefined;
  switch (decl.type) {
    case "string":
    case "enum":
    case "date":
      return raw;
    case "int":
      if (!/^-?\d+$/.test(raw)) throw new SubjectError(`${decl.label}: enter a whole number`);
      return Number(raw);
    case "bool":
      return raw === "yes";
  }
}

/** The subject a submitted form describes. Missing optional fields are left out. */
export function parseFields(schema: SubjectSchema, form: FormData): Record<string, unknown> {
  const subject: Record<string, unknown> = {};
  for (const [field, decl] of Object.entries(schema)) {
    const base = `f.${field}`;
    if (!decl.repeated) {
      const value = parseScalar(decl, form, base);
      if (value !== undefined) subject[field] = value;
      continue;
    }
    const items: unknown[] = [];
    for (let i = 0; i < MAX_ITEMS + 1; i++) {
      const value = parseScalar(decl, form, `${base}.${i}`);
      if (value !== undefined) items.push(value);
    }
    if (items.length > 0) subject[field] = items;
  }
  return subject;
}
