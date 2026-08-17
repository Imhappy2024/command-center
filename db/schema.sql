-- Executed in full on every boot. Every statement must be idempotent.

CREATE TABLE IF NOT EXISTS accounts (
  id              TEXT PRIMARY KEY,           -- provider + ':' + provider_uid
  provider        TEXT NOT NULL,              -- 'google' | 'microsoft' | 'imap'
  provider_uid    TEXT NOT NULL,              -- Google sub, Microsoft id, or <email>@<imap host>
  email           TEXT NOT NULL,
  label           TEXT NOT NULL,              -- user-supplied, shown in the sidebar
  color           TEXT NOT NULL,              -- hex, user-supplied
  refresh_token   TEXT NOT NULL,              -- AES-256-GCM ciphertext
  access_token    TEXT,                       -- ciphertext, short-lived cache
  expires_at      BIGINT,                     -- epoch ms
  scope           TEXT,
  status          TEXT NOT NULL DEFAULT 'ok', -- 'ok' | 'reauth'
  last_error      TEXT,
  connected_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_uid)
);

CREATE INDEX IF NOT EXISTS accounts_provider_idx ON accounts (provider);

/* IMAP accounts have no OAuth endpoints to derive a host from, so the server
   cannot infer where to connect. NULL for google and microsoft rows.

   For those rows refresh_token holds the encrypted app password rather than an
   OAuth refresh token. It is the same thing in every way that matters here — a
   long-lived credential that must never be stored in the clear — and giving it
   its own column would fork every read and write path for no benefit. */
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS imap_host TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS imap_port INTEGER;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS smtp_host TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS smtp_port INTEGER;

/* Not every connection is an OAuth grant. GHL issues Private Integration
   Tokens: long-lived, manually rotated, with nothing to refresh. auth_kind
   distinguishes them so the refresh path knows to leave them alone, and meta
   carries whatever else a provider needs without a column per provider. */
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS auth_kind TEXT NOT NULL DEFAULT 'oauth';
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS meta JSONB NOT NULL DEFAULT '{}';

/* Inbound webhooks are written here raw and processed asynchronously, so a slow
   handler never makes the sender retry into a duplicate. */
CREATE TABLE IF NOT EXISTS webhook_events (
  id          BIGSERIAL PRIMARY KEY,
  provider    TEXT NOT NULL,
  event_type  TEXT NOT NULL,
  external_id TEXT,
  payload     JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed   BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS wh_unprocessed ON webhook_events (provider, processed) WHERE NOT processed;
