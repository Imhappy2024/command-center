# Command Center

Single-pane operations dashboard. Ten views; the Inbox is a working multi-account mail
client, the rest are empty states until their sources are wired.

Nothing fabricates data. A view with no source says so and names what it needs.

## What is wired

| View | Source | State |
|---|---|---|
| Inbox | Gmail, Microsoft Graph, IMAP | live |
| Calendar | Google Calendar, Microsoft Graph | live |
| GHL (leads) | Supabase (GHL mirror), send via GHL | live |
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

GHL data comes from **Supabase**, and command-center only reads it. An external
pipeline — a backfill script and n8n webhooks — owns GHL -> Supabase. There is no
sync here, no cursors, no rate limiting, and nothing to connect.

```
GHL API --> backfill + webhooks --> Supabase --> command-center reads
```

Read routes never call GHL. `/api/ghl/leads`, `/api/ghl/leads/:id/thread`,
`/api/ghl/leads/:id/detail` and `/api/ghl/stages` are Supabase queries.

### Two databases

| Variable | Holds | Where |
|---|---|---|
| `DATABASE_URL` | command-center's own tables — `accounts` (mail tokens), `webhook_events`, `sync_state`, `social_*` | Railway Postgres |
| `SUPABASE_DB_URL` | the portal's GHL tables — `lead`, `ghl_*`, `appointment` | Supabase, **session pooler on 5432** |

They are deliberately separate. Pointing `DATABASE_URL` at Supabase would orphan
every connected mailbox's token. With `SUPABASE_DB_URL` unset, GHL reads fall back to
`DATABASE_URL` — the single-database layout — and the boot log says so.

`GET /api/ghl/diag` reports both connections by host and kind, per-table counts,
and whether the live trigger exists. If the sidebar is empty, open it first: the
three silent-empty causes (wrong database, RLS-blocked role, genuinely empty) read
differently there.

### Sub-accounts

They come from `ghl_location`, with brand from `company` and a lead count per
location. There is no connect step and no **+ Connect GHL** button: a sub-account
is in the sidebar because the pipeline ingested it, and the list grows on its own
as the ingest token's scope widens.

Only one location is populated today — Folio Excel, 3,296 leads. The sidebar
renders whatever rows exist rather than a fixed four.

If `ghl_location` is empty the view says the data has not been ingested and points
at the pipeline. It does not offer a button, because nothing on that screen could
fix it.

`ghl_location` is also the allow-list the unauthenticated webhook is checked
against. It used to be the `accounts` table, which meant a token had to be pasted
before a webhook would be accepted.

### Stages

Real stages, from `ghl_pipeline_stage`, in `position` order, per location. The
cards used to be a hardcoded six — New, Contacted, Qualified, Proposal, Won, Lost
— which matched no pipeline that exists. Folio's are Qualified, Demo Scheduled,
Demo Complete, Proposal Sent, Long Term Follow Up, Closed Won, Onboard Initiated:
three of those collapsed into one card and four could not be shown at all.
`lib/ghl-stages.js` and its pattern mapping are gone.

Two things worth knowing:

- **Scoped through `ghl_pipeline`, not `ghl_pipeline_stage.ghl_location_id`.**
  That column is NULL on every stage row in the mirror, so filtering the stage
  table on it returns nothing — which the write path reads as "this pipeline has
  no stages" and refuses a stage change over.
- **Status is not the stage.** GHL tracks `open | won | lost | abandoned`
  separately, and this data has a "Closed Won" stage sitting at status `open`. The
  UI takes won/lost from `status` and never infers it from a stage name, and a
  stage change no longer overwrites status with a guess.

With "All locations" selected, stages are folded by name — two pipelines both
having "Proposal Sent" is one card. That is why the leads filter keys on the stage
NAME: a folded card has no single id to offer.

### Sending — the one GHL call left

Reads come from Supabase. Sends go to GHL, because GHL owns delivery, and the
record comes back through the webhook. The dashboard never inserts a message row
on its own.

Echo suppression is the message id: on a successful POST the returned
`messageId` is inserted with `origin='dashboard'`, and the webhook GHL fires back
carries the same id, so `ON CONFLICT DO NOTHING` makes it a no-op. There is no
echo table.

Two live-verified corrections to the send reference:

- `conversationId` is **not** a request field — it appears only in the response.
  The previous build sent it and GHL ignored it.
- There is **no From-name field**. `emailFrom` sets the address; the display name
  comes from the sender GHL has verified.

`ghl_message.ghl_conversation_id` is NOT NULL, so when GHL returns no
conversation id there is nowhere to put the optimistic row. It is skipped and left
to the webhook rather than inserted blind, which would throw and make a successful
send look failed.

Sending needs a token. Being listed does not: a location with no `GHL_TOKEN_*`
pair is readable and marked read-only in the sidebar.

### Webhooks — unauthenticated

`/webhooks/ghl` stays, and is still the reason the dashboard is not stale. GHL's
Custom Webhook action posts no HMAC, so there is nothing to verify; the locationId
allow-list is what contains it. Raw payloads land in `webhook_events` and a worker
drains them into Supabase, so an unexpected shape is debuggable rather than lost.

Three shapes handled explicitly:

- **Inbound messages carry no ids at all** — no message id, no conversation id.
  They land in `ghl_message_inbox`, with the conversation id recovered from asset
  URLs in the body where one is present. Nothing goes into `ghl_message` without a
  natural key, because redelivery would duplicate it.
- **`opportunity.stage` carries no pipeline data.** It is a trigger, left in
  `webhook_events` for the ingest pipeline to diff.
- **Absent is not null.** Contact payloads omit unset fields, so a column is only
  written when its key is PRESENT. Treating absent as null wipes populated data.

### Live updates

`db/notify-triggers.sql` puts AFTER triggers on `ghl_location`, `lead`,
`ghl_opportunity`, `ghl_message` and `ghl_message_inbox` that fire
`pg_notify('cc_changes', {tbl, op, location, contact, conversation})`. UPDATE
triggers carry `WHEN (OLD.* IS DISTINCT FROM NEW.*)`, so the ingest pipeline
re-upserting an unchanged row wakes nobody. The server holds one dedicated LISTEN
connection (session pooler — LISTEN works in session mode, silently never fires in
transaction mode) and fans payloads out to open dashboards over SSE at
`GET /api/ghl/events`.

Payloads are **ids only**. The browser fetches exactly the row named:

| Event | Browser fetches | Redraws |
|---|---|---|
| `ghl_location` INSERT | `GET /api/ghl/locations/:id` | sidebar entry appended |
| `lead` or `ghl_opportunity` change | `GET /api/ghl/leads/:id` | that lead's card; stage counts if an opportunity moved |
| `ghl_message` / `ghl_message_inbox` change | that lead's row, and `…/thread` **only if that thread is open or cached** | that card and that conversation |

Events are queued and flushed together 400ms later. Up to 20 changed leads are
fetched one by one; more than that — a bulk re-ingest — becomes one
`?since=<cursor>` delta. Nothing ever re-reads the whole table because of an
event. A live message arriving while a reply is half-typed does not wipe the
draft.

The trigger file is applied at boot, idempotently, and is the one sanctioned
touch of portal tables — explicitly requested, additive only, and non-fatal: a
role without trigger privileges costs live updates, not the dashboard.

### Cache

IndexedDB in the browser, one key-value store. A reload paints sub-accounts,
leads and any previously opened conversations from cache before the network
answers, then fetches `GET /api/ghl/leads?since=<cursor>` — only rows changed
since the newest one held — and merges by id.

The cursor is the largest `changedAt` the server has returned, where `changedAt`
is the newest of the lead's `updated_at`, its opportunity's `updated_at`, and its
newest message by both sent time and ingest time (a backfilled message carries an
old sent time but a new ingest time, and a cursor on sent time alone would never
see it). It is the server's clock, so a browser with the wrong time cannot skip
rows.

**Refresh** is the escape hatch: it forces a full read and overwrites the cache.
A lead you have clicked stays read across a merge unless a newer message has
actually landed. Cache failure — private window, cleared site data, IndexedDB off
— degrades to "no cache", never to a broken page.

### Refresh, and what is not here

**Refresh** re-reads Supabase. That is the only action left.

**Re-sync is gone**, along with the connect sheet, the first-sync progress panel
and the per-location sync markers. command-center cannot start, stop or retry an
ingest run. The Leads header instead reports the pipeline's own health from
`ghl_sync_log` — failing feeds, feeds that have never completed — as a statement,
not a button.

`POST /api/ghl/sync` and `POST /api/ghl/sync/:locationId` still answer, with `501`
and an explanation, so anything still calling them is told why.


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

## Systems

Automations you trigger by hand. Six are listed; **Create a Clip** is built and
the other five are marked "Not built yet" rather than offering a dead button.

### Create a Clip

Wraps [OpusClip](https://api.opus.pro). Source, curation and render preferences,
submit, preview the rendered clips in the browser, then schedule each one to a
connected social account.

```
drop a file ──► streamed to disk ──► served at /media/<token> ──┐
                                                                 ├─► POST /clip-projects
paste a URL ────────────────────────────────────────────────────┘
                                                                     │
        preview + schedule ◄── clips table ◄── poll or webhook ◄──────┘
```

**The service fetches a URL; it does not accept an upload.** That single fact
shapes the screen. A dropped file is streamed to this server — never buffered,
because a 30 GB ceiling and `express.raw()` in the same process is an
out-of-memory crash — and served back at `/media/<48-hex-token>`, which is what
OpusClip is given.

`/media/:token` is deliberately unauthenticated: OpusClip carries no session.
What contains it is the token — 24 random bytes generated server-side, used as
the filename, pattern-checked on return so it cannot be walked into another
path, and swept after 24 hours. Range requests are supported, since a fetcher
pulling gigabytes asks for them in pieces.

| Need | Why |
|---|---|
| `OPUS_API_KEY` | every call is 401 without it |
| `PUBLIC_URL` | the address OpusClip fetches uploads from |
| A mounted volume | otherwise uploads are on ephemeral disk and die on deploy |

**Response shapes are inferred, not verified.** The base URL and bearer auth are
confirmed against the live service — `/clip-projects`, `/brand-templates` and
`/social-accounts` all answer 401 unauthenticated, which proves the paths exist.
The public documentation names the endpoints and request fields but does not
publish the response bodies, so every reader in `providers/opus.js` accepts
several plausible field names and keeps the untouched payload in `raw`.
`GET /api/systems/clip/diag` returns raw responses so the mapping can be
corrected against a real payload on the first authenticated call. Guessing one
field name and shipping it is how the Meta integration failed twice.

Clips are collected by polling (`Check for clips`) as well as by webhook at
`POST /webhooks/opus`, because a webhook that was never configured leaves a
project stuck at "processing" with no way to find out.

## Social

Sub-menu under the nav item: **Overview, YouTube, Meta, X**. Each platform view
shows a connect button until an account for it exists, then a metrics dashboard —
stat tiles, a per-day chart with a metric toggle, top posts, and the accounts
behind it with when each was last pulled. Meta has three views under one grant:
**FB Page, Instagram, Meta Ads**.

Data is pulled on a schedule — **06:00 and 12:00 America/Chicago** by default
(`SOCIAL_SCHEDULE`, `SOCIAL_SCHEDULE_TZ`) — and on demand with **Fetch now**, which
pulls only the family on screen: a YouTube click never bills an X read. One lock
covers the scheduled pass and the button, so a click during the 06:00 run answers
409 rather than starting a second pass. At boot, accounts that have *never* been
polled get one pass after 45s so a fresh connection fills before its first slot;
everything else waits for the schedule, because X bills per read and a redeploy
is not a reason to spend.

The header states when the data was last pulled and when the next pull is.

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

`.env` is read by `lib/dotenv.js` at startup — no dependency, no `--env-file` flag, and a
missing file is the normal hosted case. **Real environment variables win**, so Railway's
injected values are never overridden by a stale committed file, and a blank placeholder
left over from `.env.example` does not count as set.

> Until recently nothing loaded `.env` at all: the app read `process.env` and the startup
> error advised setting variables "in .env for a local run" — advice the code did not
> implement. Local runs only worked if you exported everything by hand.

The server refuses to start if `APP_PASSWORD`, `SESSION_SECRET`, `ENCRYPTION_KEY` or
`DATABASE_URL` is missing, names the one that is, and says whether a `.env` was found —
"set it in .env" is unhelpful when the file does not exist and misleading when it exists
with the value blank.

## Claude

A Claude Code session inside the dashboard, billed to your Claude subscription
rather than to API credits — Claude Code is a first-party client that is already
signed in, so nothing here ever calls `/v1/messages`.

**It only mounts when the app is running on your own machine.** The Railway
deployment runs `AUTH_MODE=open`, and an endpoint that spawns a coding agent with
filesystem access would hand a shell to anyone with the URL. `routes/claude.js`
checks for the environment markers every hosted platform sets (`RAILWAY_*`,
`RENDER`, `FLY_APP_NAME`, `DYNO`, `VERCEL`, `KUBERNETES_SERVICE_HOST`, …) and does
not register the router if it finds one. The boot log says which way it went.

Prerequisite: `npm i -g @anthropic-ai/claude-code`, then run `claude` once to sign
in. `lib/claude-cli.js` finds the installed `cli.js` and spawns it with this
process's own `node` — not through the `.cmd` shim, because Node refuses to spawn
a `.cmd` without a shell and `shell: true` concatenates arguments instead of
escaping them, which silently truncates any prompt containing a space.

The panel exposes the model, effort and thinking toggles, permission mode, the
tool allow-list, MCP servers (`--mcp-config`), plugin directories, extra working
directories, subagents and settings JSON, and a system-prompt suffix.

| Variable | Default | What it does |
|---|---|---|
| `CLAUDE_DIR` | the server's cwd | Working directory for turns |
| `CLAUDE_WRITE` | unset | `1` adds Edit / Write / NotebookEdit / Bash to the allow-list |
| `CLAUDE_YOLO` | unset | `1` removes the allow-list entirely (`--dangerously-skip-permissions`) |
| `CLAUDE_LOCAL` | auto | `0` forces the router off, `1` forces it on — don't force it on |
| `CLAUDE_CLI` | auto | Path to `cli.js` if it isn't where the search expects |

Read-only by default. The browser may narrow the tool set per turn but can never
widen it past what the process was started with.

`tools/claude-bridge.mjs` does the same thing as a standalone process, for
pointing the hosted dashboard at your machine. The in-app routes are simpler when
the dashboard is local: same origin, no token, no CORS.

## Installing on Windows, and updating

```powershell
irm https://raw.githubusercontent.com/Imhappy2024/command-center/main/install/install.ps1 | iex
```

`install/install.ps1` clones into `%LOCALAPPDATA%\CommandCenter`, installs
dependencies, seeds `.env`, and adds a Desktop and Start Menu shortcut. Both
`.ps1` files are plain ASCII with no BOM, because a BOM stops `param` from being
the first token and breaks that one-liner. Native commands are judged by exit
code, not by whether they wrote to stderr -- `git clone` reports progress there,
and `$ErrorActionPreference = 'Stop'` would otherwise abort a healthy install. The
launcher (`install/Command Center.cmd` → `command-center.ps1`) supervises the
process and opens the browser once the port answers.

The sidebar shows the version, commit, and whether the working copy is dirty, and
checks GitHub hourly for a newer commit on the current branch. **Update now**
refuses if there are uncommitted changes, then runs `git pull --ff-only` and
`npm install --omit=dev`. Because the launcher sets `CC_SUPERVISED=1`, a clean
exit restarts into the new code and the page reloads itself; started any other
way, `/api/app/restart` refuses and the banner says to restart it by hand.

These routes are gated exactly like the Claude ones — `git pull` reachable from a
public URL is remote code execution with a friendly name.

See `install/README.md`, including why this is an installer and not a `.exe`.

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
| `SOCIAL_SCHEDULE` / `SOCIAL_SCHEDULE_TZ` | Default `60`, floors at `15`. How often the poller runs |

**Behaviour**

| Variable | Default | Notes |
|---|---|---|
| `MAIL_FETCH_LIMIT` | `25` | Per mailbox per folder, before merging |
| `AGENT_TIMEZONE` | server zone | IANA zone deciding whether a row shows a clock, `Yesterday` or a date. Also drives the lead list's `12m` / `2h` / `Aug 4` column |
| `PGSSLMODE` | — | `disable` if your Postgres rejects TLS. Railway's private hostname is detected automatically |

**GoHighLevel** — none required. Sub-accounts come from `ghl_location` in Supabase
and are readable without any token. A `GHL_TOKEN_*` / `GHL_LOCATION_*` pair adds
one thing: the ability to SEND from that location.

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
| `GET /api/ghl/sync` | Per-location backfill status and live counts |
| `POST /api/ghl/sync/:locationId` | `202` start/restart; `409` if running. `?full=1` discards the cursor |
| `POST /api/ghl/sync` | `202`, every idle or failed location |
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

### Local only

Mounted only when no hosted-platform marker is present.

| Route | Does |
|---|---|
| `GET /api/claude/health` | Whether the router is live, the cwd, the tool allow-list |
| `GET /api/claude/auth` | `claude auth status` — proves turns bill to the subscription |
| `GET/POST /api/claude/plugins` | List, enable, disable |
| `GET /api/claude/mcp` | Configured MCP servers |
| `POST /api/claude/chat` | One turn, SSE. `sessionId` resumes |
| `POST /api/claude/stop` | Kill the running turn |
| `GET /api/app/version` | Package version, commit, branch, dirty flag |
| `GET /api/app/update-check` | Compares HEAD to the branch head on GitHub |
| `POST /api/app/update` | `git pull --ff-only` + `npm install --omit=dev` |
| `POST /api/app/restart` | Exits 0 so the launcher restarts. Needs `CC_SUPERVISED=1` |

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
