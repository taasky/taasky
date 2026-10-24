// The claim (docs/accounts.md): a person who started keyless saves their
// deals to an account. Proof of control is the Telegram chat: the bot's
// one-time sign-in link starts a session as one of the chat's ids, and a
// Google or GitHub sign-in from that session links every id of the chat to
// the identity's account. The ids' own rows stay as they are.

import * as db from "../db.js";

/** Agreements after which the bot offers the claim: the first, then once more. */
export const OFFER_AT = [1, 3] as const;

/** Whether this agreement is one after which the chat is offered the claim. */
export async function offerClaimNow(d1: D1Database, chatId: string): Promise<string | null> {
  const users = (await db.usersForTelegramChat(d1, chatId)).map((c) => c.user_id);
  if (!users.length || !(await db.noAccount(d1, users))) return null;
  const agreed = await db.countRoomsForUsers(d1, users, "agreed");
  return (OFFER_AT as readonly number[]).includes(agreed) ? users[0]! : null;
}

/**
 * Links every id of the chat behind `fromUserId` to `accountId`, and binds
 * the chat to the account if it has none. Returns how many ids were linked
 * and how many deals the account now holds, or null when there is nothing
 * to claim: no chat, or the session was the account itself.
 */
export async function claimChat(
  d1: D1Database,
  fromUserId: string,
  accountId: string,
  now: Date,
): Promise<{ chatId: string; linked: number; deals: number } | null> {
  if (fromUserId === accountId) return null;
  const channel = await db.getChannel(d1, fromUserId);
  if (channel?.kind !== "telegram") return null;
  const users = (await db.usersForTelegramChat(d1, channel.address)).map((c) => c.user_id);
  if (!(await db.noAccount(d1, users))) return null;
  const linked = await db.linkUsers(d1, users, accountId, now.toISOString());
  if (!(await db.getChannel(d1, accountId))) {
    await db.bindChannel(d1, {
      user_id: accountId,
      kind: "telegram",
      address: channel.address,
      created_at: now.toISOString(),
    });
  }
  const deals = await db.countRoomsForUsers(d1, await db.idsOf(d1, accountId));
  return { chatId: channel.address, linked, deals };
}
