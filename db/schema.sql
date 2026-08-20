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

/* ---------------------------------------------------------------------------
   GHL lead mirror.

   GHL is the source of truth; these tables are a read mirror. Exactly two
   writers: the webhook processor and the sync job. No request handler writes
   here, which is why there is no conflict resolution anywhere in this codebase
   — there are never two writable copies of a lead.

   Every primary key is '<locationId>:<recordId>'. Two sub-accounts can hold the
   same opportunity id without colliding, and a webhook can never write into a
   location it did not come from, because the locationId half is taken from the
   connected-accounts allow-list rather than from the payload.
   --------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS ghl_contacts (
  id            TEXT PRIMARY KEY,              -- '<locationId>:<contactId>'
  location_id   TEXT NOT NULL,
  contact_id    TEXT NOT NULL,
  name          TEXT,
  first_name    TEXT,
  last_name     TEXT,
  phone         TEXT,
  email         TEXT,
  source        TEXT,
  owner         TEXT,
  tags          JSONB NOT NULL DEFAULT '[]',
  custom        JSONB NOT NULL DEFAULT '{}',
  date_added    TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted       BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (location_id, contact_id)
);
CREATE INDEX IF NOT EXISTS ghl_contacts_loc ON ghl_contacts (location_id) WHERE NOT deleted;

CREATE TABLE IF NOT EXISTS ghl_pipelines (
  id            TEXT PRIMARY KEY,              -- '<locationId>:<pipelineId>'
  location_id   TEXT NOT NULL,
  pipeline_id   TEXT NOT NULL,
  name          TEXT,
  stages        JSONB NOT NULL DEFAULT '[]',   -- [{id, name, position}]
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (location_id, pipeline_id)
);

CREATE TABLE IF NOT EXISTS ghl_opportunities (
  id             TEXT PRIMARY KEY,             -- '<locationId>:<opportunityId>'
  location_id    TEXT NOT NULL,
  opportunity_id TEXT NOT NULL,
  contact_id     TEXT,
  pipeline_id    TEXT,
  stage_id       TEXT,
  stage_name     TEXT,
  status         TEXT,                         -- open|won|lost|abandoned
  name           TEXT,
  value          NUMERIC(14,2) NOT NULL DEFAULT 0,
  owner          TEXT,
  date_added     TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted        BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (location_id, opportunity_id)
);
CREATE INDEX IF NOT EXISTS ghl_opps_loc ON ghl_opportunities (location_id) WHERE NOT deleted;
CREATE INDEX IF NOT EXISTS ghl_opps_contact ON ghl_opportunities (location_id, contact_id);

/* The primary key is GHL's own message id, and that IS the echo suppression.
   A message sent from the dashboard is inserted here with origin='dashboard';
   the OutboundMessage webhook that GHL fires straight back tries the same id and
   ON CONFLICT DO NOTHING makes it a no-op. There is no separate echo table. */
CREATE TABLE IF NOT EXISTS ghl_messages (
  id              TEXT PRIMARY KEY,            -- '<locationId>:<messageId>'
  location_id     TEXT NOT NULL,
  conversation_id TEXT,
  contact_id      TEXT NOT NULL,
  direction       TEXT NOT NULL,               -- 'in' | 'out'
  channel         TEXT NOT NULL,               -- sms|email|wa|fb|ig|call|other
  body            TEXT,
  sent_at         TIMESTAMPTZ NOT NULL,
  origin          TEXT NOT NULL DEFAULT 'ghl', -- 'ghl' | 'dashboard'
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ghl_msgs_contact ON ghl_messages (location_id, contact_id, sent_at);

CREATE TABLE IF NOT EXISTS sync_state (
  key         TEXT PRIMARY KEY,                -- 'ghl:<locationId>:contacts' etc
  cursor      TEXT,
  last_run    TIMESTAMPTZ,
  last_error  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

/* The webhook receiver is unauthenticated, so a payload that fails validation is
   kept and marked processed with the reason rather than retried forever. That
   needs somewhere to put the reason. */
ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS error TEXT;
ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;

/* ---------------------------------------------------------------------------
   Social metrics.

   Platform APIs are never called from a request handler. The poller writes these
   tables and the read routes serve them, which is the only way a dashboard stays
   responsive on top of quota-metered APIs â€” YouTube's 10,000 units a day cannot
   be bought, and every X read bills at half a cent.
   --------------------------------------------------------------------------- */

/* Daily snapshots. Instagram retains user-level insights for 90 days only, so any
   history beyond that exists here and nowhere else. One row per account per day;
   re-running a day's fetch corrects it rather than duplicating. */
CREATE TABLE IF NOT EXISTS social_metrics (
  account_id   TEXT NOT NULL,
  day          DATE NOT NULL,
  followers    INTEGER,
  reach        INTEGER,
  views        INTEGER,
  interactions INTEGER,
  posts        INTEGER,
  raw          JSONB NOT NULL DEFAULT '{}',
  fetched_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, day)
);

CREATE TABLE IF NOT EXISTS social_posts (
  id           TEXT PRIMARY KEY,          -- '<accountId>:<mediaId>'
  account_id   TEXT NOT NULL,
  platform     TEXT NOT NULL,
  external_id  TEXT NOT NULL,
  title        TEXT,
  permalink    TEXT,
  published_at TIMESTAMPTZ,
  reach        INTEGER NOT NULL DEFAULT 0,
  views        INTEGER NOT NULL DEFAULT 0,
  shares       INTEGER NOT NULL DEFAULT 0,
  interactions INTEGER NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS social_posts_acct ON social_posts (account_id, published_at DESC);

CREATE TABLE IF NOT EXISTS ads_daily (
  account_id   TEXT NOT NULL,
  day          DATE NOT NULL,
  campaign_id  TEXT NOT NULL DEFAULT '',   -- '' is the account-level roll-up
  campaign     TEXT,
  objective    TEXT,
  status       TEXT,
  spend        NUMERIC(14,2) NOT NULL DEFAULT 0,
  reach        INTEGER NOT NULL DEFAULT 0,
  results      INTEGER NOT NULL DEFAULT 0,
  currency     TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, day, campaign_id)
);

/* Deliberately absent from all three tables: impressions, reel plays, page-level
   impressions, page-likes growth, and Instagram's profile_views,
   website_clicks, email_contacts, phone_call_clicks and get_directions_clicks.
   Every one of them was deprecated or removed between v22.0 and November 2025. A
   column for any of them would fill with nulls while looking like it worked. */
