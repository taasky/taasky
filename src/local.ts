// On your own machine there are no accounts, so /mcp is keyless. A client that
// signed in to an earlier node here still sends that token. This node never
// issued it, the core would answer 401, and the client would open a sign-in
// window for localhost. Local mode drops it.
export function dropStaleToken(pathname: string, headers: Headers, oneHuman: boolean): void {
  if (oneHuman && pathname === "/mcp") headers.delete("authorization");
}

// For the same reason local mode doesn't advertise OAuth. `codex mcp add`
// reads these documents, finds a sign-in, and opens a window for localhost
// although /mcp never asks for one.
const OAUTH_DISCOVERY = new Set([
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server",
]);

export function hidesOAuth(pathname: string, oneHuman: boolean): boolean {
  return oneHuman && OAUTH_DISCOVERY.has(pathname);
}
