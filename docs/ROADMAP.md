# Roadmap

What the node needs before 0.1.0 is released, in order.

## Before a release

1. **Confirmations without Telegram.** The web card is in (taasky-mcp #69,
   not yet merged; `core/` is synced from its branch). Left:
   - **Slack**, the second push channel in PROTOCOL.md §8, and the one teams
     already live in. It goes into taasky-mcp's `Notifier`, so the hosted
     service gets it too.
   - **The skill.** `taasky/plugin` knows `bind_url` only. The server's
     `next` tells the agent to send `confirm_url`; the skill should too.
2. **Identity from the company.** Keyless rooms work today, but a node should
   know who is who. Two steps:
   - first, a trusted header from the reverse proxy (`X-Forwarded-User` after
     the company's SSO);
   - later, OIDC against the company's IdP (§10).
3. **Trim the sync.** Leave the hosted-only parts out of `core/`: Google and
   GitHub sign-in, site forms, analytics, admin. That means a build flag or
   an entry point in taasky-mcp for a node.
4. **Branding off.** Pages and server instructions say "Taasky" and link to
   mcp.taasky.ai and Telegram. A node should name itself and its own URL.
5. **Docker image tested and published** (ghcr.io/taasky/node), with a
   compose file that puts Caddy in front for TLS.
6. **Licences of what core/public ships.** The fonts (Instrument Serif, Inter,
   JetBrains Mono) are under the OFL, so their licence files go next to them.
   The images and pages are Taasky's own.
7. **Security review** of what a node exposes: room tokens, the card links
   (the whole credential until identity lands), `/keys`, rate limits behind a
   proxy.

## After

- **N parties per room** (hypothesis H19). PROTOCOL.md v1 has two. Common
  ground with several teams needs it in the protocol first.
- **Cross-org** (PROTOCOL.md §2): two nodes, one per company, with the subject
  sealed from the relay.
- **Postgres** for a node that outgrows one SQLite file.
- **Upgrades:** `schema.sql` creates what is missing, but does not alter what
  exists. Migrations need to apply the way taasky-mcp's `migrations/` do.
