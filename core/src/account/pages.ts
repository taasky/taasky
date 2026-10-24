// The account pages: sign in, your agents, a new key. Labels people typed and
// app names clients registered are escaped like everything else (html.ts).

import { UPSTREAMS, type UpstreamName } from "../auth/upstream.js";
import type { Profile } from "../db.js";
import { type Deal, STANDING } from "../deals.js";
import { formatDate } from "../format.js";
import { COPY_SCRIPT, escapeHtml, page, plate } from "../html.js";
import { NAME_MAX } from "../shown.js";
import type { TelegramChat } from "../telegram.js";

const day = (iso: string | number) => formatDate(new Date(iso).toISOString().slice(0, 10));

/** The two agents, as on taasky.ai: yours in amber, theirs in indigo. */
const SPHERES = plate(
  "/img/two-spheres.webp",
  "Two glowing spheres, amber and indigo, joined by ribbons of light",
  "Fig. 1",
  "Your agent · the other side",
);

/** The paper plane, in the champagne of the page. */
const TELEGRAM_ICON = `<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M21.4 4.3 18.3 19c-.2 1-.8 1.3-1.7.8l-4.6-3.4-2.2 2.1c-.2.2-.5.5-1 .5l.3-4.7 8.6-7.8c.4-.3-.1-.5-.6-.2L6.5 13 2 11.6c-1-.3-1-1 .2-1.5L20 3.2c.8-.3 1.6.2 1.4 1.1Z"/></svg>`;

/** A numbered chapter: numeral and title on the left, the content on the right. */
const chapter = (num: string, title: string, note: string, body: string, id = "") =>
  `<section class="chapter"${id ? ` id="${id}"` : ""}>
  <header><span class="num" aria-hidden="true">${num}</span><h2>${title}</h2>${note ? `<p>${note}</p>` : ""}</header>
  <div class="body">${body}</div>
</section>`;

/** One sign-in form per provider; the buttons read "<verb> Google". */
function providerButtons(providers: readonly UpstreamName[], verb: string): string {
  return providers
    .map(
      (p) => `<form method="post" action="/account/signin/${p}">
      <button>${verb} ${UPSTREAMS[p].label}</button>
    </form>`,
    )
    .join("\n    ");
}

export function signInPage(opts: {
  providers: readonly UpstreamName[];
  telegramUrl: string | null;
  notice?: string;
}): string {
  const telegram = opts.telegramUrl
    ? `<a class="button primary" href="${escapeHtml(opts.telegramUrl)}">Sign in with Telegram <span class="arrow">&rarr;</span></a>`
    : "";
  const providers = providerButtons(opts.providers, "Sign in with");
  return page(
    "Your Taasky account",
    `<div class="acct-hero">
  <section>
  <p class="eyebrow">Your account</p>
  <h1>Your agents, <em>in one place.</em></h1>
  <p class="lede">Connect agents to the same account, get a key for one that cannot sign in,
  and disconnect any of them. No password: Telegram sends you a one-time link.</p>
  ${opts.notice ? `<p class="notice">${escapeHtml(opts.notice)}</p>` : ""}
  <div class="actions cta">
    ${telegram}
    ${providers}
  </div>
  <p><small>New here? Signing in with Telegram creates your account, and your agents'
  confirmations will come to that chat.</small></p>
  </section>
  ${SPHERES}
</div>`,
    { bodyClass: "acct" },
  );
}

export function loginConfirmPage(code: string): string {
  // A button, not an automatic sign-in: anything that fetches the link — a
  // preview, a scanner — would otherwise spend it.
  return page(
    "Sign in to Taasky",
    `<p class="eyebrow">Sign in</p>
  <h1>Open your <em>account.</em></h1>
  <p class="lede">You asked the Taasky bot for a link. It works once, in this browser.</p>
  <form method="post" action="/login/${escapeHtml(code)}" class="cta">
    <button class="primary">Sign in <span class="arrow">&rarr;</span></button>
  </form>`,
    { narrow: true },
  );
}

export interface AgentKey {
  key_hash: string;
  label: string | null;
  hint: string | null;
  created_at: string;
}

export interface ConnectedApp {
  grantId: string;
  name: string;
  createdAt: number;
}

export function accountPage(a: {
  mcpUrl: string;
  signedInAs: string;
  telegram: { bound: true; chat?: TelegramChat | null } | { bound: false; bindUrl: string | null };
  keys: AgentKey[];
  apps: ConnectedApp[];
  deals: Deal[];
  /** What the other side sees; null for an account with no Google or GitHub sign-in. */
  profile?: (Profile & { emailVerified: boolean }) | null;
  /** Whether they joined the Taasky Plus list. */
  plus?: boolean;
  /** Sign-ins that would save this Telegram-only account's deals; empty when there is nothing to save. */
  save?: readonly UpstreamName[];
  notice?: string;
}): string {
  const save = a.save?.length
    ? `<section class="side-note">
  <h2>Save your deals to an account</h2>
  <p>Every deal from every agent in one place, even if an agent loses track. No password.</p>
  <div class="actions">${providerButtons(a.save, "Save with")}</div>
</section>`
    : "";
  const rows = [
    ...a.apps.map(
      (app) => `<li><span class="bead agent" aria-hidden="true"></span>
      <div><strong>${escapeHtml(app.name)}</strong>
      <small>Signed in · since ${escapeHtml(day(app.createdAt))}</small></div>
      <form method="post" action="/account/apps/revoke"><input type="hidden" name="grant" value="${escapeHtml(app.grantId)}">
      <button class="ghost">Disconnect</button></form></li>`,
    ),
    ...a.keys.map(
      (k) => `<li><span class="bead key" aria-hidden="true"></span>
      <div><strong>${escapeHtml(k.label ?? "API key")}</strong>
      <small>Key ${k.hint ? `…${escapeHtml(k.hint)}` : ""} · since ${escapeHtml(day(k.created_at))}</small></div>
      <form method="post" action="/account/keys/revoke"><input type="hidden" name="key" value="${escapeHtml(k.key_hash)}">
      <button class="ghost">Revoke</button></form></li>`,
    ),
  ];
  const agents = rows.length
    ? `<ul class="cards">${rows.join("\n")}</ul>`
    : `<p class="empty">No agents yet. Add one below.</p>`;

  const deals = a.deals.length
    ? `<ul class="cards">${a.deals
        .map(
          (d) => `<li><span class="bead ${d.state}" aria-hidden="true"></span>
      <div><strong>${escapeHtml(d.name)}</strong>
      <small>${escapeHtml(STANDING[d.state])}${d.with ? ` · with ${escapeHtml(d.with)}` : ""} · ${escapeHtml(day(d.at))}</small></div>
      <a class="open" href="${escapeHtml(d.url)}">Open <span class="arrow">&rarr;</span></a></li>`,
        )
        .join("\n")}</ul>`
    : `<p class="empty">No deals yet. Ask your agent to settle something.</p>`;

  const p = a.profile;
  const profile = p
    ? chapter(
        "III",
        "What the other side sees",
        "On the invitation, the room page, in their Telegram and to their agent.",
        `<div class="seen${p.shown ? "" : " off"}">
    <span class="label">${p.shown ? "They see" : "Hidden · they see"}</span>
    <span class="sphere" aria-hidden="true"></span>
    <span class="who">${p.shown ? escapeHtml(p.name) : "your agent"}${
      p.shown && p.emailVerified ? `<span class="mark">Email verified</span>` : ""
    }</span>
  </div>
  <p>${
    p.shown
      ? `<strong>${escapeHtml(p.name)}</strong>${p.emailVerified ? " · email verified" : ""}, on the invitation, the room page, in their Telegram and to their agent.`
      : "Nothing: they see “your agent”."
  } This applies to rooms you start or join from now on. Your email is never shown${
    p.emailVerified ? "" : ", and “email verified” takes a Google sign-in"
  }.</p>
  <form method="post" action="/account/profile" class="cta">
    <label>Your name <small>first name and initial is enough</small>
      <input name="name" maxlength="${NAME_MAX}" value="${escapeHtml(p.name)}" required></label>
    <label class="check"><input type="checkbox" name="shown" value="1"${p.shown ? " checked" : ""}> Show my name to the other side</label>
    <button>Save</button>
  </form>`,
      )
    : "";

  // Coming soon: no price and no date until it ships (docs/accounts.md).
  const plus = `<section class="plus" id="plus">
  <p class="eyebrow">Taasky Plus · Coming soon</p>
  <h2>Taasky Plus. <em>More of you, kept.</em></h2>
  <p>Not ready yet, and nothing to pay. Join the list and you hear first when it is.</p>
  <ol>
    <li><strong>Your agent remembers your rules.</strong> Saved limits, like “never before eight”, ready-made deals, your address.</li>
    <li><strong>Your own page.</strong> Anyone can open a negotiation with you from one link.</li>
    <li><strong>Your room page, your way.</strong> Your photo, your language, a greeting.</li>
  </ol>
  ${
    a.plus
      ? `<p class="on"><strong>You're on the list.</strong></p>`
      : `<form method="post" action="/account/plus"><button class="primary">Join the list <span class="arrow">&rarr;</span></button></form>`
  }
  </section>`;

  const chat = a.telegram.bound ? a.telegram.chat : null;
  const telegram = a.telegram.bound
    ? `<div class="tg">
    <span class="tg-mark" aria-hidden="true">${TELEGRAM_ICON}</span>
    <div>
      <span class="tg-who">${chat?.username ? `@${escapeHtml(chat.username)}` : escapeHtml(chat?.name ?? "Your Telegram")}</span>
      ${chat?.username && chat.name ? `<small>${escapeHtml(chat.name)}</small>` : ""}
    </div>
    <span class="connected">Connected</span>
  </div>
  <p>Confirmations come to your Telegram.</p>`
    : a.telegram.bindUrl
      ? `<p>Telegram is not connected, so nothing reaches you when an agent needs a yes.</p>
  <a class="button inline" href="${escapeHtml(a.telegram.bindUrl)}">Connect Telegram <span class="arrow">&rarr;</span></a>`
      : `<p>Telegram is not connected.</p>`;

  const agreed = a.deals.filter((d) => d.state === "agreed").length;
  const tally = `<dl class="tally">
    <div><dt>Deals</dt><dd>${a.deals.length}</dd></div>
    <div><dt>Agreed</dt><dd${agreed ? ' class="lit"' : ""}>${agreed}</dd></div>
    <div><dt>Agents</dt><dd>${rows.length}</dd></div>
  </dl>`;

  return page(
    "Your Taasky account",
    `<div class="acct-hero">
  <section>
  <p class="eyebrow">Your account · ${escapeHtml(a.signedInAs)}</p>
  <h1>Your <em>agents.</em></h1>
  <p class="lede">What they settled for you, what the other side sees, and who can act in your name.</p>
  ${a.notice ? `<p class="notice">${escapeHtml(a.notice)}</p>` : ""}
  ${tally}
  ${save}
  </section>
  ${SPHERES}
</div>

${chapter("I", "Your deals", "Every room your agents opened or joined, newest first.", deals)}

${chapter("II", "Your agents", "Each one can negotiate for you. Disconnect any of them here.", agents)}

${profile}

${plus}

${chapter(
  profile ? "IV" : "III",
  "Add an agent",
  "Two ways in, depending on whether the agent can sign in.",
  `<div class="ways">
  <div>
    <h3>Agents that sign in</h3>
    <p>Muse, Grok Bot, ChatGPT and others. Add a custom connector (a remote MCP server) with this
    address. When Taasky's page opens in your browser, choose <em>Connect to your account</em>.</p>
    <p class="addr"><code>${escapeHtml(a.mcpUrl)}</code> <button class="inline ghost" data-copy="${escapeHtml(a.mcpUrl)}">Copy</button></p>
  </div>
  <div>
    <h3>Agents that cannot sign in</h3>
    <p>A Grok team bot on its own account, the xAI API, an agent on a server. Get a key and put
    it in the agent's settings.</p>
    <form method="post" action="/account/keys" class="cta">
      <label>Name it <small>so you know which agent has it</small>
        <input name="label" maxlength="40" placeholder="Team bot"></label>
      <button class="primary">Get a key <span class="arrow">&rarr;</span></button>
    </form>
  </div>
  </div>`,
)}

${chapter(
  profile ? "V" : "IV",
  "Telegram",
  "Where your agents ask for your yes.",
  `${telegram}
  <form method="post" action="/account/signout" class="signout">
    <button class="ghost">Sign out</button>
  </form>`,
)}
  ${COPY_SCRIPT}`,
    { bodyClass: "acct" },
  );
}

export function newKeyPage(k: { key: string; label: string | null; mcpUrl: string }): string {
  return page(
    "Your new Taasky key",
    `<p class="eyebrow">New key${k.label ? ` · ${escapeHtml(k.label)}` : ""}</p>
  <h1>Copy it <em>now.</em></h1>
  <p class="lede">This is the only time it is shown. Anyone who has it can negotiate as you;
  revoke it on your account page if it leaks.</p>
  <p><code>${escapeHtml(k.key)}</code> <button class="inline ghost" data-copy="${escapeHtml(k.key)}">Copy</button></p>

  <h2 style="margin-top:2.5rem">In the agent</h2>
  <p>Give the agent this server and header, in its connector settings or in the xAI API's
  <code>mcp</code> tool as <code>server_url</code> and <code>authorization</code>:</p>
  <dl class="facts">
    <div><dt>Server URL</dt><dd><code>${escapeHtml(k.mcpUrl)}</code></dd></div>
    <div><dt>Header</dt><dd><code>Authorization: Bearer ${escapeHtml(k.key)}</code></dd></div>
  </dl>
  <a class="button inline" href="/account">Back to your account <span class="arrow">&rarr;</span></a>
  ${COPY_SCRIPT}`,
    { narrow: true },
  );
}
