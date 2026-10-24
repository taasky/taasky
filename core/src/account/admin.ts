// Who has an account, for the people who run Taasky: GET /account/admin.
// Only the user ids in ADMIN_USERS see it; to anyone else it does not exist.
// It reads, and changes nothing.

import { formatDate } from "../format.js";
import { describeSource } from "../forms.js";
import { escapeHtml, page } from "../html.js";

export interface AdminEnv {
  /** Comma-separated user ids that may open /account/admin. */
  ADMIN_USERS?: string;
  /** Our own test accounts, marked as such in the list. */
  INTERNAL_USERS?: string;
}

const ids = (list: string | undefined) =>
  new Set(
    (list ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

export const isAdmin = (env: AdminEnv, userId: string) => ids(env.ADMIN_USERS).has(userId);

export interface Person {
  userId: string;
  firstSeen: string;
  signIns: { provider: string; email: string | null; name: string | null }[];
  telegram: boolean;
  plus: boolean;
  keys: number;
  rooms: number;
  internal: boolean;
}

export interface Lead {
  form: "business" | "waitlist";
  at: string;
  email: string;
  /** Business: name, role and company. Waitlist: the agent they use. */
  who: string;
  /** Business: use case and agents. Waitlist: their note. */
  detail: string | null;
  source: string;
}

export interface Overview {
  people: Person[];
  rooms: Record<string, number>;
  leads: Lead[];
}

/**
 * Everyone who signed in with Google or GitHub, bound Telegram or joined the
 * Plus list. A keyless id claimed into an account (user_links) counts as that
 * account, so its rooms are the account's.
 */
export async function adminOverview(d1: D1Database, env: AdminEnv): Promise<Overview> {
  const [identities, channels, plus, keys, rooms, states, links, business, waitlist] =
    await d1.batch([
      d1.prepare("SELECT user_id, provider, email, name, created_at AS at FROM identities"),
      d1.prepare("SELECT user_id, created_at AS at FROM channels"),
      d1.prepare("SELECT user_id, joined_at AS at FROM plus_list"),
      d1.prepare("SELECT user_id, COUNT(*) AS n FROM api_keys GROUP BY user_id"),
      d1.prepare("SELECT user_id, COUNT(DISTINCT room_id) AS n FROM participants GROUP BY user_id"),
      d1.prepare("SELECT state, COUNT(*) AS n FROM rooms GROUP BY state"),
      d1.prepare("SELECT user_id, account_id FROM user_links"),
      d1.prepare(
        "SELECT email, full_name, company, role, use_case, agent_framework, attribution, created_at AS at FROM early_access_leads",
      ),
      d1.prepare(
        "SELECT email, agent_runtime, note, attribution, created_at AS at FROM consumer_waitlist",
      ),
    ]);
  type Row = Record<string, string | number | null>;
  const rows = (r: D1Result) => r.results as Row[];

  const accountOf = new Map(rows(links!).map((l) => [String(l.user_id), String(l.account_id)]));
  const owner = (id: unknown) => accountOf.get(String(id)) ?? String(id);
  const internal = ids(env.INTERNAL_USERS);
  const people = new Map<string, Person>();
  const person = (id: unknown, at: unknown) => {
    const userId = owner(id);
    let p = people.get(userId);
    if (!p) {
      p = {
        userId,
        firstSeen: String(at),
        signIns: [],
        telegram: false,
        plus: false,
        keys: 0,
        rooms: 0,
        internal: internal.has(userId),
      };
      people.set(userId, p);
    }
    if (String(at) < p.firstSeen) p.firstSeen = String(at);
    return p;
  };

  for (const r of rows(identities!)) {
    person(r.user_id, r.at).signIns.push({
      provider: String(r.provider),
      email: r.email === null ? null : String(r.email),
      name: r.name === null ? null : String(r.name),
    });
  }
  for (const r of rows(channels!)) person(r.user_id, r.at).telegram = true;
  for (const r of rows(plus!)) person(r.user_id, r.at).plus = true;
  // Keys and rooms add to someone already listed; an id with only those stays keyless.
  for (const r of rows(keys!)) {
    const p = people.get(owner(r.user_id));
    if (p) p.keys += Number(r.n);
  }
  for (const r of rows(rooms!)) {
    const p = people.get(owner(r.user_id));
    if (p) p.rooms += Number(r.n);
  }

  const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
  const leads: Lead[] = [
    ...rows(business!).map((r) => ({
      form: "business" as const,
      at: String(r.at),
      email: String(r.email),
      who: `${r.full_name}, ${r.role}, ${r.company}`,
      detail: [r.use_case, r.agent_framework].filter(Boolean).join(" · "),
      source: describeSource(str(r.attribution)),
    })),
    ...rows(waitlist!).map((r) => ({
      form: "waitlist" as const,
      at: String(r.at),
      email: String(r.email),
      who: String(r.agent_runtime),
      detail: str(r.note),
      source: describeSource(str(r.attribution)),
    })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  return {
    people: [...people.values()].sort((a, b) => b.firstSeen.localeCompare(a.firstSeen)),
    rooms: Object.fromEntries(rows(states!).map((r) => [String(r.state), Number(r.n)])),
    leads,
  };
}

const day = (iso: string) => formatDate(iso.slice(0, 10));

export function adminPage(o: Overview): string {
  const real = o.people.filter((p) => !p.internal);
  const count = (f: (p: Person) => boolean) => real.filter(f).length;
  const totalRooms = Object.values(o.rooms).reduce((a, b) => a + b, 0);
  const figure = (label: string, n: number) => `<div><dt>${label}</dt><dd>${n}</dd></div>`;

  const rows = o.people
    .map((p) => {
      const signIn = p.signIns.length
        ? p.signIns
            .map(
              (s) =>
                `${escapeHtml(s.email ?? s.name ?? "no email")} <span class="muted">${escapeHtml(s.provider)}</span>`,
            )
            .join("<br>")
        : `<span class="muted">Telegram only</span>`;
      return `<tr${p.internal ? ' class="internal"' : ""}>
      <td>${day(p.firstSeen)}</td>
      <td>${signIn}${p.internal ? ' <span class="tag">test</span>' : ""}</td>
      <td>${p.telegram ? "Yes" : ""}</td>
      <td>${p.plus ? "Yes" : ""}</td>
      <td class="n">${p.keys || ""}</td>
      <td class="n">${p.rooms || ""}</td>
      <td><code>${escapeHtml(p.userId)}</code></td>
    </tr>`;
    })
    .join("");

  const states = Object.entries(o.rooms)
    .sort(([, a], [, b]) => b - a)
    .map(([s, n]) => `${escapeHtml(s)} ${n}`)
    .join(" · ");

  const leadRows = o.leads
    .map(
      (l) => `<tr>
      <td>${day(l.at)}</td>
      <td>${l.form === "business" ? "Business" : "Waitlist"}</td>
      <td>${escapeHtml(l.email)}<br><span class="muted">${escapeHtml(l.who)}</span></td>
      <td>${l.detail ? escapeHtml(l.detail) : ""}</td>
      <td><span class="muted">${escapeHtml(l.source)}</span></td>
    </tr>`,
    )
    .join("");

  return page(
    "Accounts · Taasky",
    `<style>
  .admin table { width: 100%; border-collapse: collapse; font-size: 15px; margin-top: 2rem; }
  .admin th { text-align: left; font: 11px/1.4 var(--mono); text-transform: uppercase; letter-spacing: .18em;
              color: var(--moon-subtle); padding: 0 1rem .7rem 0; border-bottom: 1px solid var(--night-rule); }
  .admin td { padding: .7rem 1rem .7rem 0; border-bottom: 1px solid var(--night-rule); vertical-align: top; color: var(--moon); }
  .admin .n { text-align: right; }
  .admin .muted { color: var(--moon-subtle); font-size: 13px; }
  .admin tr.internal td { opacity: .55; }
  .admin .tag { font: 10px/1 var(--mono); text-transform: uppercase; letter-spacing: .15em; color: var(--champagne);
                border: 1px solid var(--night-rule); padding: .2rem .4rem; margin-left: .3rem; }
  .admin .scroll { overflow-x: auto; }
  .admin h2 { margin-top: 3rem; }
  .admin .tally { max-width: 44rem; grid-template-columns: repeat(4, minmax(0, 1fr)); }
</style>
<div class="admin">
  <p class="eyebrow">Admin</p>
  <h1>Accounts</h1>
  <p class="lede">Everyone who signed in, bound Telegram or joined the Plus list. Test accounts are greyed and left out of the totals.</p>
  <dl class="tally">
    ${figure("People", real.length)}
    ${figure(
      "Google or GitHub",
      count((p) => p.signIns.length > 0),
    )}
    ${figure(
      "Telegram",
      count((p) => p.telegram),
    )}
    ${figure(
      "Plus list",
      count((p) => p.plus),
    )}
  </dl>
  <p><small>Rooms, all of them: ${totalRooms}${states ? ` · ${states}` : ""}</small></p>
  <div class="scroll"><table>
    <thead><tr><th>Since</th><th>Signed in as</th><th>Telegram</th><th>Plus</th><th class="n">Keys</th><th class="n">Rooms</th><th>Id</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="7">Nobody yet.</td></tr>`}</tbody>
  </table></div>
  <h2>Leads · ${o.leads.length}</h2>
  <p class="lede">The site's forms: business early access, and the waitlist for people without an MCP agent yet.</p>
  <div class="scroll"><table>
    <thead><tr><th>Since</th><th>Form</th><th>Who</th><th>Said</th><th>Came from</th></tr></thead>
    <tbody>${leadRows || `<tr><td colspan="5">Nobody yet.</td></tr>`}</tbody>
  </table></div>
  <p><a href="/account">Back to your account</a></p>
</div>`,
  );
}
