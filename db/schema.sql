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
   NOT HERE: the GHL mirror.

   ghl_contacts, ghl_pipelines, ghl_opportunities and ghl_messages used to be
   created here, and command-center filled them by paging the GHL API. That is
   gone. Supabase is the source of truth now, an external pipeline (a backfill
   script and n8n webhooks) owns GHL -> Supabase, and this dashboard reads
   lead, ghl_message, ghl_opportunity and the rest through lib/ghl-data.js.

   Which means this file runs against a database it does not own. It may only
   create command-center's OWN tables: accounts, webhook_events, sync_state and
   the social ones below.

   It must never CREATE, ALTER or DROP anything named ghl_*, lead, appointment,
   or any portal table. A CREATE TABLE IF NOT EXISTS against a portal table that
   already exists is worse than an error — it succeeds, changes nothing, and
   leaves the code reading columns that are not there.
   --------------------------------------------------------------------------- */

/* Kept: an interrupted job resumes from its cursor rather than starting over,
   and the social poller still uses it. */
CREATE TABLE IF NOT EXISTS sync_state (
  key         TEXT PRIMARY KEY,                -- 'ghl:<locationId>:contacts' etc
  cursor      TEXT,
  last_run    TIMESTAMPTZ,
  last_error  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

/* A backfill that failed halfway needs to be visible before it can be restarted,
   and env-seeded sub-accounts never pass through the connect sheet, so there is
   no moment where progress would otherwise be shown. Both wants the same thing:
   state that can be read and re-run.

   Progress counts ride in the existing `cursor` column as JSON rather than
   earning columns of their own — {"contacts":340,"opportunities":82,...} — since
   the per-resource rows already use that column for a pagination cursor and the
   summary row has no pagination to record. */
ALTER TABLE sync_state ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'idle';
ALTER TABLE sync_state ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE sync_state ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ;

/* The webhook receiver is unauthenticated, so a payload that fails validation is
   kept and marked processed with the reason rather than retried forever. That
   needs somewhere to put the reason. */
ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS error TEXT;
ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;

/* ---------------------------------------------------------------------------
   Social metrics.

   Platform APIs are never called from a request handler. The poller writes these
   tables and the read routes serve them, which is the only way a dashboard stays
   responsive on top of quota-metered APIs — YouTube's 10,000 units a day cannot
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

/* Delivery metrics, added after the fact. ads_daily is command-center's own
   table, so extending it is ours to do; the rule about never altering a table
   is about ghl_*, lead, appointment and the rest of the portal's schema.

   Ratios are stored as well as the counts they derive from. The counts are what
   an aggregate is computed from — a CTR cannot be averaged across days — and the
   ratio columns only ever describe the single row they sit on. */
ALTER TABLE ads_daily ADD COLUMN IF NOT EXISTS impressions BIGINT   NOT NULL DEFAULT 0;
ALTER TABLE ads_daily ADD COLUMN IF NOT EXISTS clicks      BIGINT   NOT NULL DEFAULT 0;
ALTER TABLE ads_daily ADD COLUMN IF NOT EXISTS link_clicks BIGINT   NOT NULL DEFAULT 0;
ALTER TABLE ads_daily ADD COLUMN IF NOT EXISTS ctr         NUMERIC(14,4) NOT NULL DEFAULT 0;
ALTER TABLE ads_daily ADD COLUMN IF NOT EXISTS cpc         NUMERIC(14,4) NOT NULL DEFAULT 0;
ALTER TABLE ads_daily ADD COLUMN IF NOT EXISTS cpm         NUMERIC(14,4) NOT NULL DEFAULT 0;
ALTER TABLE ads_daily ADD COLUMN IF NOT EXISTS frequency   NUMERIC(14,4) NOT NULL DEFAULT 0;

/* Deliberately absent from the ORGANIC tables: reel plays, page-level
   impressions, page-likes growth, and Instagram's profile_views,
   website_clicks, email_contacts, phone_call_clicks and get_directions_clicks.
   Every one of them was deprecated or removed between v22.0 and November 2025. A
   column for any of them would fill with nulls while looking like it worked.

   This never applied to ads. The Marketing API still returns impressions,
   clicks, ctr, cpc, cpm and frequency, and reading the note as though it did is
   what left the ads table with three columns and the ads view with no
   efficiency metric at all. */
