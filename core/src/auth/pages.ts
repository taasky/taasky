// The one web page in the sign-in flow (PROTOCOL.md §8: a web page is needed
// only for OAuth at connection time). Every value that came from the client —
// its name, domain, redirect host — was chosen by whoever registered it, so it
// is escaped before it reaches the page.

import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";

import { COPY_SCRIPT, escapeHtml, htmlResponse, page } from "../html.js";
import { UPSTREAMS, type UpstreamName } from "./upstream.js";

export function consentPage(
  details: ConsentDescription,
  handle: string,
  providers: readonly UpstreamName[],
  signedIn = false,
): string {
  const name = escapeHtml(details.clientName);
  const origin = details.clientDomain
    ? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
    : "This app registered itself; its name is not verified.";
  const loopback = details.redirectIsLoopback
    ? `<p class="warn">Access goes to an app on your own computer. Continue only if you just started connecting Taasky from it.</p>`
    : "";
  // Signing in with a provider is optional: it only lets the same account be
  // reached again from another agent or device.
  const buttons = [
    ...(signedIn
      ? [
          `<button class="primary" name="decision" value="account">Connect to your account</button>`,
          `<button name="decision" value="connect">Connect as a new account</button>`,
        ]
      : [`<button class="primary" name="decision" value="connect">Connect</button>`]),
    ...providers.map(
      (p) =>
        `<button name="decision" value="${p}">Connect with ${UPSTREAMS[p].label} account</button>`,
    ),
  ].join("\n    ");

  return page(
    "Connect Taasky",
    `<p class="eyebrow">Connect your agent</p>
  <h1>Let ${name} <em>negotiate</em> for you?</h1>
  <p class="lede">Your agent will be able to open and join negotiations and propose terms.
  Accepting, declining or withdrawing always waits for your own confirmation. No account needed.</p>
  <p>${origin} Access will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
  ${loopback}
  <form method="post" style="margin-top:2rem">
    <input type="hidden" name="handle" value="${escapeHtml(handle)}">
    ${buttons}
    <button class="ghost" name="decision" value="deny">Cancel</button>
  </form>
  <p style="margin-top:1.4rem"><small>By connecting you accept the <a href="https://taasky.ai/terms/">Terms</a>
  and the <a href="https://taasky.ai/privacy/">Privacy Policy</a>.</small></p>`,
    { narrow: true },
  );
}

export function errorPage(message: string, status = 400): Response {
  return htmlResponse(
    page(
      "Taasky · Sign-in failed",
      `<h1>Could not connect</h1><p class="lede">${escapeHtml(message)}</p>
  <p>Start connecting again from your agent.</p>`,
      { narrow: true },
    ),
    status,
  );
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * The last step of connecting. A redirect, except to a loopback address: an
 * agent on the person's own computer catches it there, but one on a server —
 * Hermes, OpenClaw — listens on the server's loopback, which this browser
 * cannot reach, and the person would be left on a browser error page hunting
 * for a code in the address bar. So the page says what to do in either case.
 */
export function finishConnecting(redirectTo: string, headers: Headers): Response {
  if (!LOOPBACK.has(new URL(redirectTo).hostname)) {
    headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers });
  }
  // Two equal answers, not a big button and a footnote: the big button was
  // pressed by people whose agent was on a server, and led them to an error.
  const html = page(
    "Finish connecting Taasky",
    `<p class="eyebrow">Almost done</p>
  <h1>Where does your <em>agent run?</em></h1>
  <p class="lede">Your agent is waiting for one link. How it gets there depends on where the agent lives.</p>
  <div class="choices">
    <section>
      <h2>In a chat or on a server</h2>
      <p>Hermes, OpenClaw, a Telegram bot, anything you message rather than run.</p>
      <button class="primary" data-copy="${escapeHtml(redirectTo)}">Copy the link</button>
      <p><small>Then paste it to your agent. It works once, for a few minutes.</small></p>
    </section>
    <section>
      <h2>On this computer</h2>
      <p>Claude Code, Cursor, a desktop app you started the connection from.</p>
      <a class="button" href="${escapeHtml(redirectTo)}">Finish here <span class="arrow">&rarr;</span></a>
      <p><small>If the next page says the site can't be reached, the agent is not on this
      computer. Come back and copy the link instead.</small></p>
    </section>
  </div>
  ${COPY_SCRIPT}`,
    { narrow: true },
  );
  const res = htmlResponse(html);
  // The consent cookies the library set must survive the change of response.
  for (const value of headers.getSetCookie()) res.headers.append("Set-Cookie", value);
  return res;
}
