// The two forms on taasky.ai, moved here from Supabase:
//   POST /forms/early-access   the business page's early access form
//   POST /forms/waitlist       "No agent that speaks MCP yet? Leave your email"
// The site posts JSON from another origin, so only taasky.ai gets CORS. Every
// field is checked here: the request comes from the open internet. AUTH_LIMITER
// (index.ts) caps each IP. The honeypot stays in the browser and never posts.

export interface FormsEnv {
  DB: D1Database;
  /** Origins allowed to post, comma-separated. Defaults to the site. */
  FORMS_ORIGINS?: string;
}

/** A new submission, told to whoever watches leads. Never awaited by the form. */
export type LeadNotify = (text: string) => void;

const PATHS: Record<string, "early-access" | "waitlist"> = {
  "/forms/early-access": "early-access",
  "/forms/waitlist": "waitlist",
};

export const ROLES = [
  "DevOps / Platform",
  "Security / SecOps",
  "Tech Lead / Architect",
  "Founder / Executive",
  "Other",
];

export const USE_CASES = [
  "Cloud Access / AWS IAM & S3",
  "Webhooks & API Integration",
  "P2P Coordination",
  "Other",
];

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: that is what it rejects.
const CONTROL = /[\u0000-\u001f\u007f]/;

class Invalid extends Error {}

type Body = Record<string, unknown>;

function text(
  body: Body,
  key: string,
  max: number,
  opts: { optional?: boolean; oneLine?: boolean } = {},
) {
  const raw = body[key];
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) {
    if (opts.optional) return null;
    throw new Invalid(key);
  }
  if (value.length > max || (opts.oneLine && CONTROL.test(value))) throw new Invalid(key);
  return value;
}

function email(body: Body) {
  const value = text(body, "email", 254, { oneLine: true })!.toLowerCase();
  if (value.length < 6 || !EMAIL.test(value)) throw new Invalid("email");
  return value;
}

function oneOf(body: Body, key: string, allowed: string[]) {
  const value = text(body, key, 100)!;
  if (!allowed.includes(value)) throw new Invalid(key);
  return value;
}

/** UTM tags, click ids, landing page and referrer: a flat object of short strings. */
function attribution(body: Body): string | null {
  const a = body.attribution;
  if (a === null || a === undefined) return null;
  if (typeof a !== "object" || Array.isArray(a)) throw new Invalid("attribution");
  if (!Object.values(a).every((v) => typeof v === "string")) throw new Invalid("attribution");
  const json = JSON.stringify(a);
  if (json.length > 4000) throw new Invalid("attribution");
  return json;
}

/** One line on where a lead came from, for the notification and the admin page. */
export function describeSource(json: string | null): string {
  let a: Record<string, string> = {};
  try {
    a = json ? JSON.parse(json) : {};
  } catch {
    // Unreadable is the same as none.
  }
  const utm = [a.utm_source, a.utm_medium, a.utm_campaign].filter(Boolean).join(" / ");
  const network =
    a.gclid || a.gbraid || a.wbraid
      ? "Google Ads"
      : a.fbclid
        ? "Meta"
        : a.msclkid
          ? "Microsoft Ads"
          : a.li_fat_id
            ? "LinkedIn"
            : null;
  const from = utm || network || a.referrer || "direct";
  return a.landing_page ? `${from}, landed on ${a.landing_page}` : from;
}

const lines = (...parts: (string | null)[]) => parts.filter((p) => p !== null).join("\n");

async function insert(
  form: "early-access" | "waitlist",
  body: Body,
  d1: D1Database,
  now: Date,
): Promise<string> {
  const id = crypto.randomUUID();
  const at = now.toISOString();
  const source = attribution(body);
  if (form === "early-access") {
    const row = {
      email: email(body),
      full_name: text(body, "full_name", 120, { oneLine: true })!,
      company: text(body, "company", 160, { oneLine: true })!,
      role: oneOf(body, "role", ROLES),
      use_case: oneOf(body, "use_case", USE_CASES),
      agent_framework: text(body, "agent_framework", 2000, { optional: true }),
    };
    await d1
      .prepare(
        `INSERT INTO early_access_leads
           (id, email, full_name, company, role, use_case, agent_framework, attribution, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        row.email,
        row.full_name,
        row.company,
        row.role,
        row.use_case,
        row.agent_framework,
        source,
        at,
      )
      .run();
    return lines(
      "🏢 New business lead",
      `${row.full_name}, ${row.role}, ${row.company}`,
      row.email,
      `Use case: ${row.use_case}`,
      row.agent_framework && `Agents: ${row.agent_framework}`,
      `Source: ${describeSource(source)}`,
    );
  }
  const row = {
    email: email(body),
    agent_runtime: text(body, "agent_runtime", 60, { oneLine: true })!,
    note: text(body, "note", 1000, { optional: true }),
  };
  await d1
    .prepare(
      `INSERT INTO consumer_waitlist (id, email, agent_runtime, note, attribution, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, row.email, row.agent_runtime, row.note, source, at)
    .run();
  return lines(
    "🙋 New consumer signup",
    row.email,
    `Agent: ${row.agent_runtime}`,
    row.note && `Note: ${row.note}`,
    `Source: ${describeSource(source)}`,
  );
}

const origins = (env: FormsEnv) =>
  (env.FORMS_ORIGINS ?? "https://taasky.ai")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/** The form's response, or null when the path is not a form. */
export async function handleForms(
  request: Request,
  env: FormsEnv,
  notify: LeadNotify,
  now = new Date(),
): Promise<Response | null> {
  const form = PATHS[new URL(request.url).pathname];
  if (!form) return null;

  const origin = request.headers.get("Origin");
  const allowed = origin !== null && origins(env).includes(origin);
  const cors: Record<string, string> = allowed
    ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" }
    : { Vary: "Origin" };
  const reply = (status: number, body: object) =>
    Response.json(body, { status, headers: { ...cors, "Cache-Control": "no-store" } });

  if (request.method === "OPTIONS") {
    if (!allowed) return new Response(null, { status: 403, headers: cors });
    return new Response(null, {
      status: 204,
      headers: {
        ...cors,
        "Access-Control-Allow-Methods": "POST",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
      },
    });
  }
  if (request.method !== "POST") return reply(405, { error: "method_not_allowed" });
  if (!allowed) return reply(403, { error: "forbidden_origin" });

  const body = (await request.json().catch(() => null)) as Body | null;
  if (!body || typeof body !== "object" || Array.isArray(body))
    return reply(400, { error: "invalid" });

  try {
    const message = await insert(form, body, env.DB, now);
    notify(message);
    return reply(201, { ok: true });
  } catch (e) {
    if (e instanceof Invalid) return reply(400, { error: "invalid", field: e.message });
    if (e instanceof Error && /UNIQUE constraint failed/.test(e.message)) {
      return reply(409, { error: "duplicate" });
    }
    throw e;
  }
}

/**
 * Sends a lead to the chat that watches them, with the leads bot (not the
 * Taasky bot people talk to). Plain text: every field comes from a public form.
 */
export async function sendLead(token: string, chatId: string, message: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: message.slice(0, 4000),
      link_preview_options: { is_disabled: true },
    }),
  });
  if (!res.ok) console.warn(JSON.stringify({ event: "lead_notify_failed", status: res.status }));
}
