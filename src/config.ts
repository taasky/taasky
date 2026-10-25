// Everything the node reads from its environment. See .env.example.

export interface Config {
  port: number;
  host: string;
  /** Where people and agents reach this node, as they see it (behind a proxy: the proxy's URL). */
  baseUrl: string;
  dbFile: string;
  /** Behind a reverse proxy: take the client address from X-Forwarded-For. */
  trustProxy: boolean;
  /** Local only: /dev/confirm and the X-Taasky-Dev-User header. Never on a shared node. */
  devMode: boolean;
  /**
   * Where people confirm. "web", the default: the card waits on this node's
   * own page, and nothing leaves the perimeter. "telegram": the bot, which
   * carries the card's text to Telegram and needs the node reachable from it.
   */
  confirmations: "web" | "telegram";
  telegramBotToken?: string;
  /**
   * Every seat in a room is the same person: one page and one yes serve them
   * all. Set by `taasky local`. Loopback only: on a shared node, whoever holds
   * one seat's link could answer for every seat.
   */
  oneHuman: boolean;
  authPerMinute: number;
  mcpPerMinute: number;
  tickMs: number;
}

export function config(env: NodeJS.ProcessEnv): Config {
  const port = Number(env.PORT ?? 8790);
  const host = env.HOST ?? "127.0.0.1";
  const baseUrl = (env.TAASKY_BASE_URL ?? `http://localhost:${port}`).replace(/\/+$/, "");
  const devMode = env.TAASKY_DEV_MODE === "1";
  if (devMode && host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error("TAASKY_DEV_MODE=1 lets anyone act as any user: bind HOST to loopback, or turn it off");
  }
  const oneHuman = env.TAASKY_ONE_HUMAN === "1";
  if (oneHuman && host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error("TAASKY_ONE_HUMAN=1 lets one seat answer for every seat: bind HOST to loopback, or turn it off");
  }
  const confirmations = env.TAASKY_CONFIRMATIONS ?? "web";
  if (confirmations !== "web" && confirmations !== "telegram") {
    throw new Error(`TAASKY_CONFIRMATIONS is "web" or "telegram", not "${confirmations}"`);
  }
  if (confirmations === "telegram" && !env.TELEGRAM_BOT_TOKEN) {
    throw new Error("TAASKY_CONFIRMATIONS=telegram needs TELEGRAM_BOT_TOKEN, your own bot");
  }
  return {
    port,
    host,
    baseUrl,
    dbFile: env.TAASKY_DB ?? "taasky.sqlite",
    trustProxy: env.TAASKY_TRUST_PROXY === "1",
    devMode,
    confirmations,
    telegramBotToken: env.TELEGRAM_BOT_TOKEN || undefined,
    oneHuman,
    authPerMinute: Number(env.TAASKY_AUTH_PER_MINUTE ?? 30),
    mcpPerMinute: Number(env.TAASKY_MCP_PER_MINUTE ?? 120),
    tickMs: Number(env.TAASKY_TICK_MS ?? 3600_000),
  };
}
