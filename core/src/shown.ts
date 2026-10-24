// The name a party shows the other side (docs/accounts.md): the person's own
// words, so every surface escapes it, and agents get it marked as data.

import type { Shown } from "./db.js";

export const NAME_MAX = 40;

/** "Ilya Bogin" → "Ilya B.": first name and initial, the default the person can change. */
export function firstNameAndInitial(full: string | null | undefined): string | null {
  const words = (full ?? "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const [first, ...rest] = words;
  const last = rest.at(-1);
  return cleanName(last ? `${first} ${[...last][0]!.toUpperCase()}.` : first!);
}

/** A name as typed: one line, no control characters, at most NAME_MAX characters. */
export function cleanName(input: string): string | null {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  const name = [...input.replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim()]
    .slice(0, NAME_MAX)
    .join("")
    .trim();
  return name || null;
}

/** "Ilya B. · email verified", as plain text. */
export const shownText = (s: Shown) => `${s.name}${s.emailVerified ? " · email verified" : ""}`;

/** For an agent: who the other side is, when they show it. */
export const shownForAgent = (s: Shown | null) =>
  s && { name: s.name, email_verified: s.emailVerified };
