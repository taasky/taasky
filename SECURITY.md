# Security

Report vulnerabilities privately, not in public issues: through GitHub's
"Report a vulnerability" on this repository. (TODO before release: a security
contact address and a response time.)

## What a node holds

- **Rooms and moves.** This includes the subject in cleartext: the internal
  track trusts the node's operator with it.
- **Room tokens, card links and API keys, as hashes only.** A token is the
  whole credential for its seat in one room; a card link, for one answer.
- **OAuth grants and tokens** of agents that signed in.

Back up and protect the SQLite file as you would the documents it summarises.

## Settings that matter

- **`TAASKY_DEV_MODE=1`** lets anyone who reaches the node act as any user. The
  node refuses it unless `HOST` is loopback. Never set it on a shared node.
- **`TAASKY_TRUST_PROXY=1`** only behind a proxy that sets `X-Forwarded-For`
  itself. Otherwise a client picks its own address and slips past rate limits.
- **TLS** comes from the reverse proxy. The node speaks plain HTTP.
