// What the agent should do now, in one sentence, from the room as
// negotiation_read sees it. Agents without the skill see only the tool
// results, and even with it they tend to report "it's your turn" back to
// their human instead of moving. The hint names the move; it decides nothing.

import type { Breach } from "./limits.js";
import type { RoomState } from "./state.js";

export interface NextInput {
  state: RoomState;
  yourTurn: boolean;
  /** Who put the terms on the table, if anyone has. */
  termsBy: "you" | "peer" | null;
  /** null: no limits were set; []: within them. */
  outside: Breach[] | null;
  limitsCannotMeet: boolean;
  circling: boolean;
  awaitingYourHuman: boolean;
  /** Your human tapped Don't on this move, and nothing has happened in the room since. */
  humanDeclined?: "approve" | "reject" | "cancel" | null;
  /** You have made a move in this room (an opening offer counts). */
  youMoved: boolean;
}

export function nextStep(r: NextInput): string {
  if (r.state === "agreed") {
    return "Agreed. Tell your human the final terms from terms_on_table, in their local time.";
  }
  if (r.state === "closed" || r.state === "expired") {
    return `The room is ${r.state}; nothing more can happen in it. Tell your human if they don't know yet.`;
  }
  if (r.awaitingYourHuman) {
    return "Your move is waiting for your human's yes on their page (human_url). Don't move again; remind them and send the link if it has been a while.";
  }
  if (r.humanDeclined) {
    const what =
      r.humanDeclined === "approve" ? "approving these terms" : `your ${r.humanDeclined}`;
    return (
      `Your human tapped Don't on ${what}, so nothing was sent. Don't send it again unless they ask: ` +
      "tell them it is not settled, and ask whether to counter, wait or withdraw."
    );
  }
  if (r.limitsCannotMeet) {
    return "Your limits and theirs cannot overlap: tell your human and suggest withdrawing with negotiation_cancel.";
  }
  if (r.state === "draft") {
    return r.youMoved
      ? "Waiting for the other side to join; your opening terms are on the invitation. Check back later."
      : "Make your opening offer now: negotiation_propose with verdict offer, one concrete slot or price inside your limits.";
  }
  if (!r.yourTurn) return "Waiting for the other side. Check back later; nothing to do now.";
  if (r.circling) {
    return "The last moves brought no new terms. Ask your human what they can live with, or suggest withdrawing; don't restate your terms.";
  }
  if (r.termsBy !== "peer") {
    return "Your move: negotiation_propose with verdict offer, one concrete slot or price inside your limits.";
  }
  if (r.outside === null) {
    return "Your move. Compare their terms with what your human asked for: approve them with negotiation_respond if they fit, otherwise counter.";
  }
  if (r.outside.length > 0) {
    const fields = r.outside.map((b) => b.field).join(", ");
    return `Their terms are outside your human's limits (${fields}): counter now with negotiation_propose, keeping their terms where you can and yours only there. Then tell your human what you sent.`;
  }
  return "Their terms are within your human's limits: approve them now with negotiation_respond (your human confirms on their page), unless your human asked for something they don't meet. Then tell your human.";
}
