-- Taasky negotiation state. See PROTOCOL.md.
-- The relay stores the envelope; `subject` is opaque to it by contract
-- (§2) even though this table can hold it in cleartext on the B2C track.

CREATE TABLE IF NOT EXISTS rooms (
  id                TEXT PRIMARY KEY,
  state             TEXT NOT NULL,          -- draft|awaiting|agreed|closed|expired
  round             INTEGER NOT NULL DEFAULT 0,
  turn              TEXT,                   -- participant id to move next
  invite_code       TEXT UNIQUE,
  invite_expires_at TEXT,
  deadline          TEXT,
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS participants (
  id             TEXT PRIMARY KEY,
  room_id        TEXT NOT NULL REFERENCES rooms(id),
  user_id        TEXT NOT NULL,
  role           TEXT NOT NULL,             -- initiator|peer
  subject_schema TEXT NOT NULL,             -- JSON, declared on open/join (§4)
  limits         TEXT,                      -- JSON, private bounds (§7); never shown to the peer
  options        TEXT,                      -- JSON: the initiator's alternatives to pick from, opening offer first
  standing_hash  TEXT,                      -- terms this party picked and already confirmed, played when the turn comes
  profile_id     TEXT,                      -- profiles.account_id when the party showed a name on entering
  joined_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id           TEXT PRIMARY KEY,
  room_id      TEXT NOT NULL REFERENCES rooms(id),
  seq          INTEGER NOT NULL,
  from_id      TEXT NOT NULL,
  round        INTEGER NOT NULL,
  verdict      TEXT NOT NULL,
  in_reply_to  TEXT,
  subject_hash TEXT,
  deadline     TEXT,
  ts           TEXT NOT NULL,
  subject      TEXT                         -- JSON or NULL on control moves
);

-- approve / reject / cancel are never played by the agent alone (§8). The
-- agent's request waits here until its human releases or declines it, and is
-- re-checked against the room at that moment — the room may have moved on.
CREATE TABLE IF NOT EXISTS pending_moves (
  id             TEXT PRIMARY KEY,
  room_id        TEXT NOT NULL REFERENCES rooms(id),
  participant_id TEXT NOT NULL REFERENCES participants(id),
  verdict        TEXT NOT NULL,             -- approve|reject|cancel
  subject_hash   TEXT,                      -- approve only
  status         TEXT NOT NULL,             -- pending|released|declined|stale|superseded
  created_at     TEXT NOT NULL,
  resolved_at    TEXT
);

-- Who a Taasky user is, as an upstream provider vouches for it (§10). The
-- user id is ours, so a second provider can later be linked to the same user.
CREATE TABLE IF NOT EXISTS identities (
  provider   TEXT NOT NULL,                 -- google|github
  subject    TEXT NOT NULL,                 -- the provider's stable id, never the email
  user_id    TEXT NOT NULL,
  email      TEXT,
  name       TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (provider, subject)
);

-- Bearer keys for agents that cannot finish a browser OAuth flow (§10). Only
-- the SHA-256 is stored; the key itself is shown once, by POST /keys.
CREATE TABLE IF NOT EXISTS api_keys (
  key_hash   TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  label      TEXT,                          -- what the human called it: "Grok Bot"
  hint       TEXT                           -- last 4 characters, to tell keys apart
);

-- Where a user's human is reached (§8): the chat their confirmations go to.
-- Bound once, through a deep link; one chat may serve several users.
CREATE TABLE IF NOT EXISTS channels (
  user_id    TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,                 -- telegram
  address    TEXT NOT NULL,                 -- telegram chat id
  created_at TEXT NOT NULL
);

-- One-time codes in t.me/<bot>?start=<code>, handed to the human by their
-- agent before a channel is bound. Used once, then deleted.
CREATE TABLE IF NOT EXISTS bind_codes (
  code       TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- A party answering from the browser, without an agent (§10). The token is
-- the whole credential: /p/<token> is that person's view of one room. Kept in
-- clear, like invite codes, so a notification can carry the link again.
CREATE TABLE IF NOT EXISTS web_links (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  room_id    TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- The account page (src/account). A browser holds a random token in a cookie;
-- only its SHA-256 is kept, like API keys.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- One-time sign-in links the Telegram bot sends: /login/<code>. Used once,
-- then deleted; good for minutes.
CREATE TABLE IF NOT EXISTS login_codes (
  code       TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Keyless agents (§10): no account, no sign-in. Opening or joining a room
-- hands the agent a room token, and that token is the whole credential — one
-- party in one room. Behind it is a user of its own, so everything keyed by
-- user (Telegram, pending moves) works unchanged. Only the SHA-256 is kept.
CREATE TABLE IF NOT EXISTS room_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  room_id    TEXT NOT NULL REFERENCES rooms(id),
  created_at TEXT NOT NULL
);

-- /r/<token>: a read-only view of a room for the human behind an agent, so
-- Telegram can link to the terms instead of describing them. Kept in clear,
-- like web_links, so every message can carry the same link.
CREATE TABLE IF NOT EXISTS view_links (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  room_id    TEXT NOT NULL REFERENCES rooms(id),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_web_links_user ON web_links(user_id, room_id);
CREATE INDEX IF NOT EXISTS idx_participants_room ON participants(room_id);
CREATE INDEX IF NOT EXISTS idx_participants_user ON participants(user_id);
-- Unique: two moves racing for the same seq must not both land.
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, seq);
CREATE INDEX IF NOT EXISTS idx_pending_room      ON pending_moves(room_id, participant_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rooms_invite ON rooms(invite_code);
CREATE INDEX IF NOT EXISTS idx_api_keys_user    ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_channels_address ON channels(kind, address);
CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_view_links_user  ON view_links(user_id, room_id);
CREATE INDEX IF NOT EXISTS idx_room_tokens_room ON room_tokens(room_id);

-- A keyless id claimed by an account (docs/accounts.md). The rows of the
-- keyless id stay as they are; "whose rooms are these" resolves through
-- here, so room tokens keep working and a link can be undone.
CREATE TABLE IF NOT EXISTS user_links (
  user_id    TEXT PRIMARY KEY,                -- a keyless id
  account_id TEXT NOT NULL,                   -- an id with an identity (identities.user_id)
  linked_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS user_links_account ON user_links (account_id);

-- The name an account shows the other side (docs/accounts.md). A row exists
-- once the person has seen the switch, on the account page; rooms entered
-- from then on carry it (participants.profile_id), rooms before it never do.
CREATE TABLE IF NOT EXISTS profiles (
  account_id TEXT PRIMARY KEY,                -- identities.user_id
  name       TEXT NOT NULL,                   -- first name and initial to start, theirs to edit
  shown      INTEGER NOT NULL DEFAULT 1,      -- 0 hides it everywhere, rooms already under way too
  created_at TEXT NOT NULL                    -- when they first saw the switch
);

-- Taasky Plus is coming soon (docs/accounts.md): who pressed "Join the list"
-- on the account page, to hear first when it ships. No price, no payment.
CREATE TABLE IF NOT EXISTS plus_list (
  user_id   TEXT PRIMARY KEY,
  joined_at TEXT NOT NULL
);

-- The site's two forms (src/forms.ts): business early access and the waitlist
-- for people without an MCP agent yet. attribution is the JSON the site sends.
CREATE TABLE IF NOT EXISTS early_access_leads (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  full_name       TEXT NOT NULL,
  company         TEXT NOT NULL,
  role            TEXT NOT NULL,
  use_case        TEXT NOT NULL,
  agent_framework TEXT,
  attribution     TEXT,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS consumer_waitlist (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  agent_runtime TEXT NOT NULL,
  note          TEXT,
  attribution   TEXT,
  created_at    TEXT NOT NULL
);
