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
  /** Confirmations in Telegram: the only channel outside dev mode until web and Slack land (docs/ROADMAP.md). */
  telegramBotToken?: string;
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
  // Without a channel the core logs the card and tells the agent its human was asked: nobody would be.
  if (!devMode && !env.TELEGRAM_BOT_TOKEN) {
    throw new Error(
      "no confirmation channel: set TELEGRAM_BOT_TOKEN (your own bot), or TAASKY_DEV_MODE=1 on loopback. Web and Slack confirmations: docs/ROADMAP.md",
    );
  }
  return {
    port,
    host,
    baseUrl,
    dbFile: env.TAASKY_DB ?? "taasky.sqlite",
    trustProxy: env.TAASKY_TRUST_PROXY === "1",
    devMode,
    telegramBotToken: env.TELEGRAM_BOT_TOKEN || undefined,
    authPerMinute: Number(env.TAASKY_AUTH_PER_MINUTE ?? 30),
    mcpPerMinute: Number(env.TAASKY_MCP_PER_MINUTE ?? 120),
    tickMs: Number(env.TAASKY_TICK_MS ?? 3600_000),
  };
}
