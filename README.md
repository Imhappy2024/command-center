# Command Center

Single-pane operations dashboard. Ten views; the Inbox is a working multi-account mail
client, the rest are empty states until their sources are wired.

Nothing fabricates data. A view with no source says so and names what it needs.

## What is wired

| View | Source | State |
|---|---|---|
| Inbox | Gmail, Microsoft Graph, IMAP | live |
| Calendar | Google Calendar, Microsoft Graph | live |
| Leads | GoHighLevel, two-way | live |
| Social | Meta (Pages, Instagram, Ads), YouTube, X | live; metrics and ads only |
| Overview, Tasks, Notes, Properties, Financial, Systems | — | empty states |

## Mail

Every connected mailbox merges into one list, newest first, each row tagged with the
account it came from and striped in that account's colour.

- **Read** — click a row; the body is fetched on open, and the message is marked read at
  the provider.
- **Act** — mark unread, star, archive, trash, restore from trash, not-spam.
- **Send** — reply from the open message, from that mailbox's own address.
- **Folders** — Open, per-mailbox, Drafts, Trash, Spam, Archive.

Folder counts come from each provider's own tallies rather than from the loaded list, so
they stay right while only one folder is on screen.

### Scopes

The minimum that works, deliberately:

| Provider | Scopes |
|---|---|
| Google | `openid` `email` `gmail.modify` `calendar.readonly` |
| Microsoft | `openid` `email` `offline_access` `Mail.ReadWrite` `Mail.Send` `Calendars.Read` |
| IMAP | app password; full mailbox rights by nature |

`gmail.modify` covers read, labels, archive, trash, drafts and send. `gmail.compose` is
redundant alongside it, and `profile` is unnecessary because `openid email` already carries
the `sub` claim and the address.

**Permanent delete is not available on Google.** `users.messages.delete` requires the full
`https://mail.google.com/` scope — total mailbox access — which is far more than the
feature earns. The UI hides "Delete forever" on Google accounts instead of offering a
button that always fails. Microsoft and IMAP can hard-delete, and do.

One grant covers both feeds. Google's returns Gmail **and** Google Calendar; Microsoft's
returns Graph Mail **and** Graph Calendars. There is no separate calendar connection, no
second consent screen, and no `calendars` table.

## Connecting a mailbox

Sign in, **+ Connect new email**, pick a provider, choose a label and colour, continue.

- **Google / Microsoft** — you approve at their own sign-in page. The account chooser is
  forced, so connecting a second address adds a mailbox rather than overwriting the first.
- **IMAP** — host, port and an app password, entered in the dialog. The credentials are
  proved against the host before anything is stored, so a typo fails in the form rather
  than as a permanently empty mailbox.

Accounts are keyed by **provider account id** — Google's `sub`, Microsoft's `id`,
`<address>@<host>` for IMAP — not by email address, because addresses change and aliases
collide. The address is a display field.

Reconnecting refreshes the tokens and clears the error state while keeping the label and
colour you chose. Rename or recolour with `POST /api/accounts/:id`.

A mailbox whose refresh fails is marked `reauth` and kept: the sidebar shows it with a red
marker and the others keep loading. Nothing is deleted, so the label and colour survive.

Tokens and app passwords are AES-256-GCM ciphertext in Postgres, keyed from
`ENCRYPTION_KEY`. The browser only ever holds a session cookie.

## Leads

GoHighLevel, one sub-account per Private Integration Token. **GHL is the source
of truth and Postgres holds a read mirror**, which is what makes this tractable:

```
Reads   GHL --webhook--> webhook_events --> mirror tables --> dashboard
Writes  dashboard --> GHL API --> webhook --> mirror tables --> dashboard
```

Exactly two things write to the mirror — the webhook processor and the sync job.
No request handler does. There is no conflict resolution anywhere in the lead code
because there are never two writable copies.

Read routes never call GHL. `/api/ghl/leads` and `/api/ghl/leads/:id/thread` are
mirror queries, so the Leads view is fast and independent of GHL's rate limits.

### Connecting

Either paste a token in **+ Connect GHL**, or declare pairs in the environment
(below) and they connect at boot. Both verify the token against
`GET /locations/{id}` before storing it, so a bad token or a missing scope is a
specific message rather than a pipeline that silently never fills.

Scopes the token needs:

```
contacts.readonly contacts.write
opportunities.readonly opportunities.write
conversations.readonly conversations.write
conversations/message.readonly conversations/message.write
locations.readonly users.readonly
```

A first sync pages pipelines, then contacts, then opportunities, then
conversations from the last `GHL_BACKFILL_DAYS`. It runs detached, resumes from a
cursor if interrupted, and until it finishes the Leads view says so rather than
showing an empty pipeline.

### Webhooks — unauthenticated

Point a GHL workflow's **Custom Webhook** action at `POST /webhooks/ghl` and have
it set an `event` field to one of `contact.created`, `contact.updated`,
`opportunity.created`, `opportunity.updated`, `opportunity.stage`,
`message.inbound`, `message.outbound`, `note.created`.

There is no signature and no shared secret. GHL's Custom Webhook action sends no
HMAC, so there was never a signature to verify. **What contains it is the
locationId allow-list**: a payload naming a location you have not connected writes
nothing, is stored with the reason, and still answers 200, so a prober cannot tell
a valid location from an invalid one. The body is capped at 256KB and the endpoint
at 60 requests per minute per IP.

Payload values are not trusted either. Opportunity and message events re-read
from GHL with that location's own token, so the worst a forged webhook achieves is
a read of a record that already exists.

### Stage names

GHL stage names are user-defined per pipeline and will not match the six the UI
shows. `lib/ghl-stages.js` is the whole translation and the one file to edit when a
pipeline is renamed. `status` wins over the stage name, since a workflow can close
a deal without moving it, and an unmatched name falls back to `contacted` rather
than being dropped.

Writing a stage the pipeline has no counterpart for is refused, not approximated.

### What is not built

- **Notes.** `note.created` events are stored in `webhook_events` and go no
  further; there is no notes mirror table yet.
- **Delete events.** Not subscribed, because delete webhooks are unreliable across
  most CRMs. The daily full reconcile pass decides deletions instead, by marking
  rows it did not see. Nothing is ever hard-deleted.
- **Incremental update detection.** GHL's contact list is ordered by `dateAdded`
  and this endpoint set has no `updatedAfter` filter, so an hourly pass reliably
  catches *new* contacts while an edit to an old one arrives by webhook and,
  failing that, on the daily full pass.

## Social

Metrics and ads. **No DMs** — Facebook and Instagram messaging needs Advanced
Access, which is its own review cycle, and when it lands those threads belong in
the Inbox as accounts rather than in a second messaging UI here.

Same shape as Leads: a poller writes snapshot tables, the read routes serve them,
and **no platform API is ever called from a request handler**. That is not
tidiness — YouTube's quota cannot be bought, Meta Ads throttles on a spend-scaled
budget, and X bills per read.

| Provider | Connects | Yields |
|---|---|---|
| Meta | one sign-in | a row per Page, per linked Instagram account, per ad account |
| YouTube | separately | one channel |
| X | separately | one account |

LinkedIn is permanently out. The Community Management API needs a screencast and
a live sign-off call for follower counts, and messaging is not available to
commercial integrations at all. The view renders it as a dimmed "API closed" tile.

### One Meta grant, several accounts

Meta is the reason `lib/oauth.js` grew a `discover()` hook. The code exchange
returns a short-lived token and **no refresh token**, so it is swapped for a
60-day long-lived one, and renewal repeats that swap at seven days out. Page
tokens derived from it never expire.

Facebook's dialog lets the user choose which Pages to grant, so **connecting one
Page when four exist is correct**, not a failure. `ads_read` is checked against
what was actually granted rather than what was asked for.

### Metrics that no longer exist

Nothing in this codebase requests any of these. They error or return nothing while
looking like they work:

- `impressions` on media and user insights, and reel `plays` — deprecated in Graph
  v22.0, effective across all versions from 21 April 2025. `views` replaced it, and
  requests on media created after 2 July 2024 error outright.
- **Facebook page-level impressions**, page likes growth, and the by-language,
  by-city and by-country breakdowns — removed November 2025. Only reach survives at
  page level, under the confusing name `page_impressions_unique`.
- Instagram `profile_views`, `website_clicks`, `email_contacts`,
  `phone_call_clicks`, `get_directions_clicks` — deprecated in v22.0.

Used instead: `views`, `reach`, `follower_count`, `accounts_engaged`,
`total_interactions`, `shares`.

### What the cards cannot show

Three honest gaps, all visible in the UI rather than papered over:

- **YouTube and X have no reach figure.** Neither publishes a unique-account
  measure, and substituting views would be exactly the relabelling this dashboard
  refuses elsewhere. The table stores NULL; the card shows `0` because it has
  nowhere to say "not published". Engagement rate is 0 for the same reason.
- **The Content table hides YouTube and X posts.** It ranks by shares per reach,
  and a post with no reach has no rank. The response says how many were hidden.
- **Follower deltas start at 0.** No platform offers a historical follower series,
  so a delta needs two snapshots taken `range` days apart. Until the poller has
  been running that long the answer is 0, which is the truth rather than an
  estimate. This is what `social_metrics` exists for — Instagram retains
  user-level insights for 90 days only.

## Run locally

```bash
npm install
cp .env.example .env
npm run dev
```

You need a Postgres to point `DATABASE_URL` at. The schema is applied on every boot and
every statement is idempotent, so there is nothing to migrate by hand.

The server refuses to start if `APP_PASSWORD`, `SESSION_SECRET`, `ENCRYPTION_KEY` or
`DATABASE_URL` is missing, and names the one that is.

## Provider setup

### Google

1. Cloud console → new project.
2. **APIs and Services → Library** → enable **Gmail API** and **Google Calendar API**.
3. **Google Auth Platform → Branding** — app name, support email, authorised domain.
4. **Audience** — on Workspace choose **Internal**: no verification, no test-user cap, no
   seven-day token expiry. On consumer Gmail you must choose **External**, add yourself
   under *Test users*, then **Publish app** immediately, or the refresh token dies after
   seven days. Leave it unverified.
5. **Clients → Create client → Web application**, redirect URIs byte for byte:
   ```
   http://localhost:3000/oauth/callback/google
   https://<your-domain>/oauth/callback/google
   ```

`gmail.modify` is a **restricted** scope. Reading your own mailboxes falls under the
personal-use exception, so no CASA assessment applies — but that is why the scope list is
kept to the minimum, and why `mail.google.com` is not requested.

### Microsoft

1. `portal.azure.com` → Entra ID → **App registrations → New registration**.
2. Supported account types: **any organizational directory and personal Microsoft
   accounts** — this is what lets one work Outlook and one hotmail address coexist.
3. **Authentication → Web**, same two redirect URIs with `/microsoft`.
4. **Certificates and secrets → New client secret** — copy the **Value**, not the Secret
   ID. It is shown once.
5. **API permissions → Microsoft Graph → Delegated**: `Mail.ReadWrite`, `Mail.Send`,
   `Calendars.Read`, `User.Read`, `offline_access`. No admin consent needed.

### IMAP

Nothing server-side. Host, port and app password go in the connect dialog. Gmail and
Outlook over IMAP need an app password, not the account password.

## Deploy to Railway

1. **New Project → Deploy from GitHub repo**.
2. Add a **Postgres** database to the same project — `DATABASE_URL` is injected.
3. **Settings → Networking → Generate Domain**, then paste it into both providers'
   redirect URI lists.
4. **Variables** → set everything under *Required* below before the first deploy, or the
   boot check kills the container and the logs name the variable.

Nixpacks detects Node and runs `npm start`. `railway.json` points the health check at
`/api/health`, which answers without a session.

No volume is needed. Tokens are in Postgres precisely because the container filesystem is
ephemeral.

### Variables

**Required — the server will not start without these**

| Variable | Notes |
|---|---|
| `SESSION_SECRET` | 32+ chars. Signs session and OAuth state cookies |
| `ENCRYPTION_KEY` | 32+ chars. Encrypts refresh tokens and app passwords. Changing it makes every stored credential undecryptable |
| `PUBLIC_URL` | Derived from `RAILWAY_PUBLIC_DOMAIN` when that is present, so on Railway you only set it to override a custom domain |
| `DATABASE_URL` | Injected by Railway's Postgres plugin |
| `APP_PASSWORD` | **Only when `AUTH_MODE` is `remember` or `password`.** Requiring it under `open` is what once locked the owner out |

**Access**

| Variable | Default | Notes |
|---|---|---|
| `AUTH_MODE` | `remember` | `open` — no gate at all, and the rail says so. `remember` — one sign-in per browser, 365-day sliding cookie. `password` — 14-day cookie, no sliding |

**Deployment**

| Variable | Notes |
|---|---|
| `PUBLIC_URL` | e.g. `https://command-center.up.railway.app`, no trailing slash. Set it: Railway's proxy reports `http` in `req.protocol`, so a header-derived redirect URI will not match what you registered |
| `PORT` | Injected by Railway. Only set it locally |

**Providers** — omit a pair and that provider shows as unavailable in the connect dialog,
with the variable it needs.

| Variable | Notes |
|---|---|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Web application client. Also used by YouTube, which needs its own redirect URI on the same client |
| `MS_CLIENT_ID` / `MS_CLIENT_SECRET` | Secret **value** |
| `MS_TENANT_ID` | `common` supports work and personal accounts |
| `META_APP_ID` / `META_APP_SECRET` | Business-type app. Covers Pages, Instagram and Ads in one grant |
| `META_WEBHOOK_VERIFY_TOKEN` | You invent it; Meta echoes it back at `GET /webhooks/meta` |
| `X_CLIENT_ID` / `X_CLIENT_SECRET` | OAuth 2.0 "Web App". **Reads bill at $0.005 each** |
| `SOCIAL_POLL_MINUTES` | Default `60`, floors at `15`. How often the poller runs |

**Behaviour**

| Variable | Default | Notes |
|---|---|---|
| `MAIL_FETCH_LIMIT` | `25` | Per mailbox per folder, before merging |
| `AGENT_TIMEZONE` | server zone | IANA zone deciding whether a row shows a clock, `Yesterday` or a date. Also drives the lead list's `12m` / `2h` / `Aug 4` column |
| `PGSSLMODE` | — | `disable` if your Postgres rejects TLS. Railway's private hostname is detected automatically |

**GoHighLevel** — none required. Omit them all and sub-accounts are added through
the Connect sheet instead.

| Variable | Default | Notes |
|---|---|---|
| `GHL_RECONCILE_MINUTES` | `60` | Incremental pass cadence. Full pass runs daily regardless. Floors at 5 |
| `GHL_BACKFILL_DAYS` | `90` | How far back conversations are pulled on a first sync. Older threads are not mirrored |
| `GHL_TOKEN_<NAME>` | — | Private Integration Token. Pairs with `GHL_LOCATION_<NAME>` on the suffix |
| `GHL_LOCATION_<NAME>` | — | Location ID — the string after `/location/` in the sub-account URL |
| `GHL_LABEL_<NAME>` | — | Sidebar label. Falls back to the name GHL reports, then the suffix title-cased |
| `GHL_COLOR_<NAME>` | — | Hex. Falls back to the next unused swatch |

Tokens never auto-refresh, so **rotation is an edit here**: on the next deploy the
new value is detected, verified, stored, and the account's reauth flag clears. An
unchanged token costs no API calls at all, and a label you have since set in the UI
is never overwritten from the environment. A pair missing its `GHL_LOCATION_` is
named in the boot log and skipped rather than failing the deploy.

## Layout

```
server.js                  Boot checks, migrate, listen
lib/app.js                 Express assembly, mountable without a database
lib/crypto.js              AES-256-GCM for stored credentials
lib/session.js             Signed-cookie sessions, password gate, PKCE helpers
lib/oauth.js               Provider config, code exchange, token refresh
lib/accounts.js            accounts CRUD and getAccessToken()
lib/normalise.js           Shared message and event shaping
lib/ghl-sync.js            Mirror writers, backfill, reconciliation
lib/ghl-webhook.js         Payload validation and the async processor
lib/ghl-limiter.js         Per-location request pacing
lib/ghl-stages.js          GHL stage name <-> UI stage
lib/ghl-seed.js            GHL_TOKEN_* / GHL_LOCATION_* pairs, read at boot
lib/social-sync.js         The social poller and its snapshot writers
db/schema.sql              accounts, webhook_events, GHL mirror, social snapshots
db/index.js                pg pool, query helper, migration runner
providers/index.js         Dispatch by provider
providers/google.js        Gmail + Google Calendar
providers/microsoft.js     Graph mail + calendarView
providers/imap.js          IMAP + SMTP
providers/ghl.js           GHL API surface, normalised
providers/meta.js          Long-lived token swap, asset discovery, insights
providers/youtube.js       Data API + Analytics API
providers/x.js             User and post metrics, with the call counter
routes/auth.js             /login, /logout
routes/connect.js          /connect/:provider, /oauth/callback/:provider, /api/accounts
routes/mail.js             /api/mail and the actions
routes/calendar.js         /api/calendar
routes/ghl.js              /api/ghl/*, and the open webhook receiver
routes/social.js           /api/social, and the Meta webhook challenge
routes/guard.js            Turns a database outage into a 503, not a crash
public/index.html          Shell, all ten views, every view's logic
public/login.html          Sign-in page, served in remember and password modes
```

That is the whole import graph, rooted at `server.js`. There is no dead code left
in it: the first-generation `.mjs` modules, the snapshot pipeline under
`scripts/`, and the old `public/app.js` were deleted once nothing imported them.
Recover any of them from git history if a source collector is worth reviving.

## API

All of these need a session. API routes answer `401` JSON; page routes redirect to
`/login`.

| Route | Returns |
|---|---|
| `GET /api/health` | `{ ok, uptime, ts }` — open, no session |
| `GET /api/accounts` | `{ canConnect, providers, accounts }` |
| `POST /api/accounts/:id` | Rename or recolour |
| `DELETE /api/accounts/:id` | Disconnect |
| `GET /api/mail?folder=&account=&limit=` | `{ messages, counts, perAccount, warnings }` |
| `GET /api/mail/capabilities` | Per-account `hardDelete` and `feeds` |
| `GET /api/mail/:accountId/:messageId` | Full message with body |
| `POST /api/mail/:accountId/:messageId/read` | `{ read }` |
| `POST /api/mail/:accountId/:messageId/star` | `{ star }` |
| `POST /api/mail/:accountId/:messageId/move` | `{ folder }` |
| `DELETE /api/mail/:accountId/:messageId` | Permanent delete; refused on Google |
| `POST /api/mail/:accountId/send` | `{ to, subject, body, replyTo? }` |
| `GET /api/calendar?from=&to=&account=` | `{ events, warnings }` |
| `GET /api/ghl/locations` | `{ locations }` |
| `POST /api/ghl/locations` | `{ locationId, token, label, color }` — verifies, then backfills |
| `DELETE /api/ghl/locations/:id` | Disconnect a sub-account |
| `GET /api/ghl/leads?location=&stage=` | `{ leads, warnings }` — mirror only |
| `GET /api/ghl/leads/:id/thread` | `{ thread }` — mirror only |
| `POST /api/ghl/leads/:id/message` | `{ channel, body }` |
| `PATCH /api/ghl/leads/:id` | `{ stage?, expectedStage?, name?, phone?, email?, owner?, value? }`; `409` if GHL moved it first |
| `POST /webhooks/ghl` | **Open, no session.** Allow-listed by `locationId` |
| `GET /api/social?range=7\|28\|90` | `{ platforms, configured, notice }` — snapshot tables only |
| `GET /api/social/ads?range=` | `{ ads, configured, notice }`; `ads` is `null` when no ad account is connected |
| `GET /api/social/posts?range=` | `{ posts, configured, notice }` |
| `GET /webhooks/meta` | Open. Echoes `hub.challenge` |

`account=all` fans out with `Promise.allSettled`. A failing mailbox contributes a
`warnings` entry, never a 500. Each account is fetched to `MAIL_FETCH_LIMIT` so a busy
mailbox cannot crowd the others out; the merged list is not trimmed afterwards, because
trimming would reintroduce exactly that crowding.

### Message shape

```js
{ id, acct, folder, from, addr, subject, snippet, body, time, sortKey, unread, star, reply }
```

`id` is an opaque provider string — Gmail's are hex, Graph's are long base64, IMAP's are
`<folder>:<uid>` because IMAP UIDs are unique per folder rather than per mailbox. Never
coerce them to numbers. `body` is `null` in a list and arrives on open. `time` is
preformatted for display; `sortKey` is epoch ms and drives the merge order.

### Event shape

```js
{ id, cal, title, location, attendees, start, end, allDay }
```

`cal` is the `accounts.id`, the same value a message carries as `acct`. `start` and `end`
are ISO 8601 for timed events and date-only `YYYY-MM-DD` for all-day ones, so the grid can
place them on the viewer's calendar day rather than shifting them across midnight.

## Known gaps

- **Six views are empty states.** Overview, Tasks, Notes, Properties, Financial and
  Systems have no source wired.
- **No social DMs.** Facebook and Instagram messaging needs Advanced Access and a
  separate review cycle. When it lands those threads go in the Inbox as accounts.
- **No Meta webhook receiver.** `POST /webhooks/meta` is still 501: this is a
  metrics build with no subscriptions, and answering 200 would tell Meta a
  receiver exists when none does. The `hub.challenge` echo works, so a
  subscription can be set up ahead of the handler.
- **The Leads detail pane's secondary actions are still inert.** *Call*, *Task*,
  *Note* and *Open in GHL* flip their own button text and nothing else — there is
  no endpoint behind them. Sending, stage moves and field edits are real.
- **No draft saving.** There is no draft-write endpoint, so the reader has no *Save draft*
  button. Gmail's `drafts.create` and Graph's `POST /me/messages` would both do it.
- **Nothing routes mail to ClickUp.** The mockup's *Send to ClickUp* button is gone rather
  than faked. `scripts/sources/clickup.mjs` still holds a working client.
- **`GET /api/mail/capabilities` has no caller.** It exists so the UI can hide
  *Delete forever* on Google accounts; the frontend never fetches it, so the
  control is hidden by other means.
- **The demo switch is still shipped.** `buildDemo()` and both *Demo data* buttons
  are roughly 230 lines that `INTEGRATIONS.md` §10 says to delete before shipping.
- **Archive has no cheap count on Gmail**, because it is defined by the absence of a label
  rather than the presence of one. It reports `null` and the sidebar shows blank.
- **IMAP opens a connection per operation.** Fine for one user; it adds about a second to
  each call.
- **`data/dashboard.json` is a leftover.** It was the snapshot payload the deleted
  pipeline wrote and the removed `/api/data` route served. Nothing reads it. It is not
  under `public/`, so it is not reachable from a browser; it can go whenever.
