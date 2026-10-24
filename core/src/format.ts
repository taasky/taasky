// How money and dates read to a human, the same on the web page and in
// Telegram. Plain text: callers escape it where it becomes HTML.

/** "€1,500.00". The amount is a decimal string and is formatted exactly, never via a float. */
export function formatMoney(value: { amount: string; currency: string }): string {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: value.currency }).format(
    value.amount as unknown as number,
  );
}

/** "Sat, 31 Oct 2026". A date names a day, not a moment, so no time zone applies. */
export function formatDate(value: string): string {
  return new Date(`${value}T00:00:00Z`).toLocaleDateString("en-GB", {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
