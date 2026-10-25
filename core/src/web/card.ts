// The confirmation card on the person's own page of a room (/r/<token>). The
// page already shows the terms (termsBlock), in the reader's own time zone,
// so the card carries only what the terms panel does not: the question, the
// limits the terms break, the counters on offer, and the buttons. The
// question and the buttons come from the bot's card (cardMessage), so the two
// channels ask the same thing.

import { formatValue } from "../card.js";
import { escapeHtml } from "../html.js";
import type { ConfirmationCard } from "../notifier.js";
import { breachText, type cardMessage } from "../telegram.js";

/**
 * `msg` is the bot's card rendered without the other side's name, so its
 * second line is the question. Each form names the parked move it answers,
 * so a page left open never answers a newer one.
 */
/** Telegram's date entities as <time>, which the page shows in the reader's own zone. */
const webTimes = (html: string) =>
  html.replace(
    /<tg-time unix="(\d+)"[^>]*>([^<]*)<\/tg-time>/g,
    (_, unix: string, text: string) =>
      `<time datetime="${new Date(Number(unix) * 1000).toISOString()}">${text}</time>`,
  );

export function cardHtml(card: ConfirmationCard, msg: ReturnType<typeof cardMessage>): string {
  const parts = [`<p>${msg.text.split("\n")[1] ?? ""}</p>`];
  const broken = (card.terms?.fields ?? []).flatMap((f) =>
    (f.breaches ?? []).map(
      (b) => `<li><b>${escapeHtml(f.label)}</b>: ${breachText(f.type, b)}</li>`,
    ),
  );
  if (broken.length) parts.push(`<p>⚠️ Outside the limits you set:</p><ul>${broken.join("")}</ul>`);
  else if (card.terms?.limits === "within") parts.push("<p>✅ Within the limits you set.</p>");
  if (card.terms?.labels_untrusted) {
    parts.push(
      "<p><small>The other side wrote the field names below. Check the values.</small></p>",
    );
  }
  const instead = card.instead ?? [];
  if (instead.length) {
    const items = instead.map((alt, i) => {
      const what = alt.fields
        .map((f) => `<b>${escapeHtml(f.label)}</b>: ${escapeHtml(formatValue(f.type, f.value))}`)
        .join(", ");
      const tag = alt.closest ? " <small>(as close as your limits allow)</small>" : "";
      return `<li>${instead.length > 1 ? `${i + 1}. ` : ""}${what}${tag}</li>`;
    });
    parts.push(
      `<p>${instead.length === 1 ? "Or propose instead:" : "Or propose one of these instead:"}</p><ul>${items.join("")}</ul>`,
    );
  }
  const buttons = msg.reply_markup.inline_keyboard.flat().flatMap((b) => {
    if ("url" in b) return [];
    const [kind, , index] = b.callback_data.split(":");
    const decision = kind === "c" ? "confirm" : kind === "d" ? "decline" : "instead";
    return [
      `<form method="post"><input type="hidden" name="pending" value="${escapeHtml(card.pending_id)}"><input type="hidden" name="decision" value="${decision}">${
        index === undefined
          ? ""
          : `<input type="hidden" name="option" value="${escapeHtml(index)}">`
      }<button${kind === "c" ? ' class="primary"' : ""}>${escapeHtml(b.text)}</button></form>`,
    ];
  });
  return webTimes(`<section class="card-ask" id="confirm"><p class="eyebrow">Waiting for your yes</p>${parts.join("")}
<div class="actions">${buttons.join("")}</div>
<p><small>Your agent asked for this. Nothing is sent until you answer.</small></p></section>`);
}
