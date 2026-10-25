// On your own machine there are no accounts, so /mcp is keyless. A client that
// signed in to an earlier node here still sends that token. This node never
// issued it, the core would answer 401, and the client would open a sign-in
// window for localhost. Local mode drops it. /mcp/account keeps its OAuth.
export function dropStaleToken(pathname: string, headers: Headers, oneHuman: boolean): void {
  if (oneHuman && pathname === "/mcp") headers.delete("authorization");
}
