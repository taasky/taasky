const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no look-alikes

function random(n: number): string {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
}

export const userId = () => `usr_${random(12)}`;
export const roomId = () => `rm_${random(10)}`;
export const participantId = () => `pt_${random(10)}`;
export const messageId = () => `msg_${random(12)}`;
export const pendingId = () => `pm_${random(12)}`;
/** Shown to humans and pasted into chats, so kept short and unambiguous. */
export const inviteCode = () => random(8);
/**
 * The code from whatever the agent was handed: the invite link itself, on
 * either host, or the bare code at its end. One link serves the person and
 * their agent alike.
 */
export function inviteCodeOf(input: string): string {
  const s = input.trim();
  return s.match(/\/i\/([a-z0-9]+)/i)?.[1] ?? s;
}
/** /p/<token>: a browser party's personal link to one room. About 129 bits. */
export const webToken = () => random(26);
/** Telegram deep-link payload: [A-Za-z0-9_-], at most 64 chars. About 79 bits. */
export const bindCode = () => random(16);
/** Secret part of an API key: 32 symbols of 31, about 158 bits. */
export const apiKey = () => random(32);
/** Account page cookie: about 158 bits. Only its hash is stored. */
export const sessionToken = () => random(32);
/** /login/<code>, sent by the Telegram bot. About 99 bits, used once, good for minutes. */
export const loginCode = () => random(20);
/** A keyless agent's credential for one room. About 129 bits; only its hash is stored. */
export const roomToken = () => `rt_${random(26)}`;
