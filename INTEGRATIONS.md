# Command Center: Integration Spec

Supersedes CLAUDE_CODE_BRIEF.md. Everything the backend needs, per integration, with the traps documented.

**Current state:** `public/index.html` is a finished single-file dashboard. All view state lives in a handful of arrays at the top of the second `<script>` tag. Nothing else in the file holds data.

**Rule:** every render function already works against the shapes below. If you find yourself editing `drawList`, `drawCal`, `drawLeads` or `drawSocial`, the backend normalisation is wrong. Fix the backend.

---

## 0. Build order

Do these in order. Each one is independently shippable and the later ones depend on approvals that take real calendar time.

| # | Integration | Blocked by | Start the paperwork |
|---|---|---|---|
| 1 | Google mail + calendar | Nothing | Day one |
| 2 | Microsoft mail + calendar | Nothing | Day one |
| 3 | GHL leads | Nothing, tokens are self-serve | Day one |
| 4 | YouTube | Nothing | Whenever |
| 5 | Meta organic (FB + IG) | Business Verification, App Review | **Day one, it gates everything** |
| 6 | Meta Ads | Business Verification, then API call volume | After #5 |
| 7 | X | Billing setup | Whenever |
| 8 | LinkedIn | Do not build | Never |

Business Verification runs on Meta's clock, not yours. Start it the first day even though you will not touch Meta code for weeks.

---

## 1. Shared foundations

### Stack

Node 20+, Express 4, `pg`, `compression`. No ORM, no bundler, no TypeScript. Single-user dashboard.

### Storage

Postgres via Railway's plugin, which injects `DATABASE_URL`. **Never the filesystem.** Railway containers are ephemeral and a redeploy would wipe every connection.

```sql
CREATE TABLE IF NOT EXISTS connections (
  id            TEXT PRIMARY KEY,        -- '<provider>:<provider_uid>'
  provider      TEXT NOT NULL,           -- google|microsoft|ghl|meta|youtube|x
  provider_uid  TEXT NOT NULL,           -- stable ID from the provider
  display       TEXT NOT NULL,           -- email, page name, location name
  label         TEXT NOT NULL,           -- user-chosen, shown in the sidebar
  color         TEXT NOT NULL,           -- user-chosen hex
  auth_kind     TEXT NOT NULL,           -- 'oauth' | 'static_token'
  secret        TEXT NOT NULL,           -- AES-256-GCM ciphertext
  access_token  TEXT,                    -- ciphertext, short-lived cache
  expires_at    BIGINT,
  scope         TEXT,
  meta          JSONB DEFAULT '{}',      -- provider-specific extras
  status        TEXT NOT NULL DEFAULT 'ok',   -- ok | reauth
  last_error    TEXT,
  last_sync     TIMESTAMPTZ,
  connected_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_uid)
);

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
```

One table for every connection type. `auth_kind` distinguishes an OAuth grant with a refresh token from a static token like GHL's. `secret` holds the refresh token or the static token depending on kind.

### Secrets

AES-256-GCM, key from `ENCRYPTION_KEY`. Never log a token, not truncated, not in error paths. Never return one to the browser.

### Session — superseded, see TASK-002

**The always-on password gate described in earlier versions of this spec is withdrawn.** It contradicted commit 7f2bad6 and it locked the owner out of his own dashboard.

Auth is now controlled by `AUTH_MODE`, defaulting to `remember`:

| Value | Behaviour |
|---|---|
| `open` | No gate. No `/login`, no redirect, no session check. `APP_PASSWORD` not required to boot. |
| `remember` | One sign-in per browser. 365-day cookie, expiry slides forward on every request. |
| `password` | 14-day cookie. |

Two rules that follow from this:

- The connect-endpoint guard keys on `ENCRYPTION_KEY`, **not** `APP_PASSWORD`. Encryption is what actually matters for storing a token; a login is a separate concern.
- Inject `window.__AUTH_MODE` into the served HTML. The frontend renders a "No login · public URL" line in the rail footer when the value is `open`, so an unprotected deployment never looks identical to a gated one.

Stated once for the record: on `open`, this URL serves live mail from every connected mailbox and exposes endpoints that attach new ones. Cloudflare Access in front of the Railway domain gives zero friction without that exposure, if the owner wants it later.

### Failure model

One dead connection never takes down the others. Fan out with `Promise.allSettled`, collect failures into a `warnings` array on the response, set that connection's `status='reauth'`, and keep serving everything else. The UI already renders a red marker per account.

### Environment

```bash
AUTH_MODE=remember             # open | remember | password
APP_PASSWORD=                  # only required when AUTH_MODE=password or remember
SESSION_SECRET=
ENCRYPTION_KEY=
PUBLIC_URL=                    # https://your-app.up.railway.app, no trailing slash
DATABASE_URL=                  # Railway injects

GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

MS_CLIENT_ID=
MS_CLIENT_SECRET=
MS_TENANT_ID=common

META_APP_ID=
META_APP_SECRET=
META_WEBHOOK_VERIFY_TOKEN=     # you invent this, Meta echoes it back

X_CLIENT_ID=
X_CLIENT_SECRET=

GHL_WEBHOOK_SECRET=            # for verifying inbound GHL webhooks

MAIL_FETCH_LIMIT=25
REFRESH_INTERVAL_MINUTES=15
```

Fail loudly on boot if `SESSION_SECRET`, `ENCRYPTION_KEY`, `PUBLIC_URL` or `DATABASE_URL` is missing. Name the missing one and exit.

**Do not require `APP_PASSWORD` unless `AUTH_MODE` is `password` or `remember`.** Requiring it under `open` is what locked the owner out.

---

## 2. Google (mail + calendar)

**One grant covers both.** Never build a separate calendar connect.

### Human setup

Console, project, enable **Gmail API** and **Google Calendar API**. Auth Platform, Branding, then Audience:

- **On Workspace:** User type **Internal**. No verification, no test-user cap, no 7-day expiry. Take this if available.
- **On consumer Gmail:** **External**, add yourself as a test user, then **immediately Publish app** to move status from Testing to In production. Leave it unverified.

Clients, Create client, Web application. Redirect URIs, both exactly:
```
http://localhost:3000/oauth/callback/google
https://<railway-domain>/oauth/callback/google
```

### Authorize

`https://accounts.google.com/o/oauth2/v2/auth`

```
client_id
redirect_uri=<PUBLIC_URL>/oauth/callback/google
response_type=code
scope=openid email profile
      https://www.googleapis.com/auth/gmail.modify
      https://www.googleapis.com/auth/calendar.readonly
access_type=offline
prompt=select_account consent
include_granted_scopes=true
code_challenge=<S256>
code_challenge_method=S256
state
```

### The four things that break this

**`prompt=select_account` is mandatory.** Without it, connecting a second mailbox silently reauthorises the account already signed in to the browser, the upsert keys to the same `provider_uid`, and it overwrites instead of adding. No error appears. This is the single most common multi-account failure.

**`access_type=offline` or no refresh token,** and the connection dies within the hour.

**Testing status kills tokens at 7 days.** Publishing to In production removes it. Unverified is fine under the personal-use exception.

**`gmail.modify`, not `gmail.readonly`.** The UI archives, trashes and marks read, so read-only cannot do the job. Before finalising, check the current sensitive-versus-restricted classification in Google's OAuth API Verification FAQ, because the tier Google assigns decides whether a CASA assessment ever applies. Under the personal-use exception it should not.

### Endpoints

- Identify: `GET https://openidconnect.googleapis.com/v1/userinfo`, take `sub` and `email`
- Token: `POST https://oauth2.googleapis.com/token`
- Mail list: `GET /gmail/v1/users/me/messages?q=<folder query>&maxResults=<MAIL_FETCH_LIMIT>`
- Mail get: `GET /gmail/v1/users/me/messages/{id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`
- Mark read: `POST /users/me/messages/{id}/modify` `{"removeLabelIds":["UNREAD"]}`
- Star: `addLabelIds: ["STARRED"]`
- Archive: `removeLabelIds: ["INBOX"]`
- Trash: `POST /users/me/messages/{id}/trash`
- Calendar: `GET https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=&timeMax=&singleEvents=true&orderBy=startTime`

`singleEvents=true` expands recurring events into instances. Without it you get the recurrence rule and have to expand it yourself.

### Refresh

Google **omits** `refresh_token` on refresh. Keep the stored one when the response has none.

---

## 3. Microsoft (mail + calendar)

### Human setup

Entra, App registrations, New. Supported account types: **Accounts in any organizational directory and personal Microsoft accounts**, which is what allows both a work Outlook and a personal hotmail address. Redirect URI platform **Web**, same two URLs with `/microsoft`. Certificates and secrets, copy the **Value** not the Secret ID, it shows once.

Delegated permissions: `Mail.ReadWrite`, `Mail.Send`, `Calendars.Read`, `User.Read`, `offline_access`.

### Authorize

`https://login.microsoftonline.com/{MS_TENANT_ID}/oauth2/v2.0/authorize`, same params as Google except `response_mode=query`, `prompt=select_account`, and `offline_access` in the scope list instead of `access_type=offline`.

### Endpoints

- Identify: `GET https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName`
- Mail: `GET /me/mailFolders/{folder}/messages?$top=25&$orderby=receivedDateTime desc`
- Mark read: `PATCH /me/messages/{id}` `{"isRead": true}`
- Flag: `{"flag": {"flagStatus": "flagged"}}`
- Move: `POST /me/messages/{id}/move` `{"destinationId": "archive"}`
- Calendar: `GET /me/calendarView?startDateTime=&endDateTime=` with header `Prefer: outlook.timezone="<tz>"`

Use `calendarView`, **not** `/me/events`. Only calendarView expands recurring events.

### The trap

**Microsoft rotates refresh tokens.** Every refresh returns a new one and invalidates the old. Persist it on every single refresh or the connection dies the second time you use it.

### Folder mapping

| App | Gmail query | Graph folder |
|---|---|---|
| inbox | `in:inbox` | `inbox` |
| drafts | `in:drafts` | `drafts` |
| trash | `in:trash` | `deleteditems` |
| spam | `in:spam` | `junkemail` |
| archive | `-in:inbox -in:trash -in:spam -in:drafts` | `archive` |

---

## 4. GHL (leads) — Private Integration Tokens

**Not OAuth.** The UI already reflects this: the connect sheet asks for a Location ID, a token, a label and a colour. No redirect.

### What a PIT is

A long-lived, scoped token generated from a sub-account's UI. It behaves as a fixed OAuth access token: it **does not auto-refresh** and only changes when rotated manually. One token per sub-account, so a three-location agency means three rows in `connections`.

Trade-off worth stating plainly: PITs are simpler than OAuth and correct for tokens you own, but nothing renews them. When one is rotated or revoked in GHL, calls start failing and the only fix is pasting a new one. Set `status='reauth'` on the first 401 and surface it rather than retrying forever.

### Human setup, per sub-account

Sub-account, Settings, Integrations, Private Integrations, create token, select scopes, copy immediately. GHL will not show it again.

Scopes the dashboard needs:
```
contacts.readonly contacts.write
opportunities.readonly opportunities.write
conversations.readonly conversations.write
conversations/message.readonly conversations/message.write
locations.readonly users.readonly
```

Location ID is the string after `/location/` in the sub-account URL.

### Calling it

```
Base:    https://services.leadconnectorhq.com
Headers: Authorization: Bearer <PIT>
         Version: 2021-07-28
         Accept: application/json
```

The `Version` header is required. Omitting it produces confusing failures.

### Connect endpoint

`POST /api/ghl/locations` with `{ locationId, token, label, color }`.

Verify before storing: call `GET /locations/{locationId}` with the token. A 200 means it is valid and scoped to that location. A 401 means bad token, a 403 means missing scopes. Return the specific error so the sheet can show it. Only encrypt and insert on success, with `auth_kind='static_token'` and `provider_uid=locationId`.

### Endpoints

- Contacts: `GET /contacts/?locationId=`
- Opportunities: `GET /opportunities/search?location_id=&pipeline_id=`
- Pipelines: `GET /opportunities/pipelines?locationId=`
- Conversations: `GET /conversations/search?locationId=&contactId=`
- Messages: `GET /conversations/{conversationId}/messages`
- Send: `POST /conversations/messages` with `{ type: 'SMS'|'Email'|'WhatsApp'|'FB'|'IG', contactId, message }`
- Update stage: `PUT /opportunities/{id}` with the new `pipelineStageId`

### Rate limits

100 requests per 10 seconds and 200,000 per day, **per resource**, meaning per location. Read these headers and back off at 80%:

```
X-RateLimit-Max, X-RateLimit-Remaining,
X-RateLimit-Limit-Daily, X-RateLimit-Daily-Remaining
```

Exponential backoff on 429: 1s, 2s, 4s. Never poll in a loop when a webhook would do.

### Two-way sync

This is the part that is not symmetric and where these builds usually go wrong.

**Outbound (you to GHL)** is optimistic: mutate local state, render, fire the call, revert and show an error on failure. The UI already does the local half.

**Inbound (GHL to you)** is **webhooks, not polling.** Build the receiver *before* the write path or you will ship a UI that looks correct and is stale.

Subscribe to at minimum: `ContactCreate`, `ContactUpdate`, `OpportunityCreate`, `OpportunityUpdate`, `OpportunityStageUpdate`, `InboundMessage`, `OutboundMessage`.

Verify the signature header on every inbound webhook. Write raw payloads into `webhook_events` and process asynchronously, so a slow handler never causes GHL to retry into a duplicate.

**Echo suppression.** When you send a message through the API, GHL fires `OutboundMessage` straight back at you. Without a guard you render your own message twice. Keep a short-lived set of message IDs you originated and drop matching webhooks, or dedupe on the GHL message ID before insert.

**Last-write-wins is wrong for stage changes.** If a workflow moves a lead while you have a stale stage on screen, your next write reverts it. Send the stage you read along with the update and reject on mismatch, or re-read before writing.

---

## 5. Meta (Facebook Page + Instagram + Ads)

One Meta app, one grant, three surfaces. Start Business Verification immediately.

### Human setup

developers.facebook.com, create app, type **Business**. Add products: Facebook Login, Instagram, Marketing API. Business Manager must be verified with legal documents before any Advanced Access submission can proceed.

### The access model, stated plainly

Standard Access covers assets you own and added to the app, and **only lets you message people who hold a role on your app.** Your actual customers do not. So reading your own metrics works on Standard Access, but replying to a real person's DM requires Advanced Access, which means App Review plus Business Verification, and `pages_messaging` and `instagram_manage_messages` are **separate review cycles.**

Plan for: metrics working in week one, replies working in month two.

### Permissions

| Purpose | Permission | Access needed |
|---|---|---|
| Page metrics | `pages_read_engagement`, `pages_show_list` | Standard |
| IG metrics | `instagram_basic` | Standard |
| Page DMs | `pages_messaging` | **Advanced** |
| IG DMs | `instagram_manage_messages` | **Advanced** |
| Ads read | `ads_read` | Standard for own accounts |
| Ads write | `ads_management`, `business_management` | Advanced |

### Metrics that no longer exist

Do not build a card for any of these. They return errors or nothing:

- **`impressions`** on media and user insights, and reel `plays`. Deprecated in Graph API v22.0, effective across all versions from 21 April 2025. `views` replaced it everywhere. Requests for impressions on media created after 2 July 2024 return an error.
- **Facebook page-level impressions**, plus **page likes growth, by language, by city, by country.** Gone November 2025. Only reach remains at page level.
- **`profile_views`, `website_clicks`, `email_contacts`, `phone_call_clicks`, `get_directions_clicks`** on IG. Deprecated in v22.0.

Use: `views`, `reach`, `follower_count`, `accounts_engaged`, `total_interactions`, `reposts`.

Two further limits: demographics need at least 100 followers, and user-level metrics only retain 90 days. If you want a longer memory, snapshot daily into your own table. Media metrics keep 2 years.

### Messaging windows

24 hours from the customer's last message. Beyond that you need a tag. The `human_agent` tag extends to 7 days and needs its own App Review approval plus completed Business Verification. `CONFIRMED_EVENT_UPDATE`, `ACCOUNT_UPDATE` and `POST_PURCHASE_UPDATE` stopped working in an April 2026 policy change and now return errors.

Bots must disclose they are automated at the start of a thread, after a long gap, and on handoff.

### Where messages go

**Into the Inbox, not the Social view.** A Page DM is a thread with a counterparty and a reply box, identical in shape to email. Add them as accounts with `provider='meta'` and reuse the entire mail pipeline. The Social view is metrics and ads only. This is a deliberate design decision, already reflected in the UI.

### Meta Ads

Renamed **May 4, 2026**: "Ads Management Standard Access" is now the **Marketing API Access Tier**. Any guide using the old name is stale.

- **Limited Access:** verified Business Manager plus a live app with Marketing API enabled.
- **Full Access:** at least 500 Marketing API calls in the past 15 days with an error rate below 15% across the last 500 calls. Lowered from 1,500.

Note that the Marketing API Access Tier and the `ads_management` permission are **two separate approval paths.** Clearing one does not clear the other.

Rate limits scale with the ad account's monthly spend, delivered in the `X-Business-Use-Case-Usage` response header. Throttle at 80%. At 100% you get error code 17 and calls fail until the window resets.

- Insights: `GET /v19.0/act_{ad_account_id}/insights?fields=spend,reach,actions,cost_per_action_type&date_preset=last_28d`
- Campaigns: `GET /v19.0/act_{id}/campaigns?fields=name,objective,status,insights{spend,actions}`

### The 90-day rule

If your app does not use a permission for 90 days, usually through user inactivity, the user must grant it again. Build the reauth path now.

---

## 6. YouTube

Cheapest and easiest. Same Google OAuth app, extra scopes.

Add `https://www.googleapis.com/auth/youtube.readonly` and `https://www.googleapis.com/auth/yt-analytics.readonly`.

**The Data API and the Analytics API are different products.** Data API gives point-in-time counts. Analytics API gives time series and requires OAuth from the channel owner. You need both.

Quota is 10,000 units per day per project, and **you cannot buy more.** The only path is an audit and quota extension form with no guaranteed timeline, and data-heavy use cases are routinely rejected.

Costs: a read is 1 unit, a **search is 100**, an upload is 1,600. Never call `search.list` when you already have IDs. `videos.list` accepts 50 IDs per call for 1 unit.

Cache for 5 to 15 minutes minimum. YouTube stats do not change by the second.

No DMs. Comments are the only conversation surface: `commentThreads.list`, then `comments.insert` to reply.

---

## 7. X

Pay-per-use since February 2026, restructured again on 20 April. No free tier.

- Post read: $0.005
- Post create: $0.015, or **$0.20 if it contains a link**
- DM send: $0.015
- Cap: 2 million post reads per month, then Enterprise at roughly $42,000/month

Basic at $200/month and Pro at $5,000/month are closed to new signups, and remaining Basic subscribers were auto-migrated to pay-per-use from 1 June 2026.

At your volume this is single-digit dollars monthly. **Meter it anyway** and surface the spend in the UI, because the link-post rate is 13x the plain rate and it is easy to not notice.

OAuth 2.0 with PKCE. Refresh tokens rotate, same as Microsoft.

---

## 8. LinkedIn

**Do not build this.** The Messaging API is not part of the Marketing Developer Platform and is not available for commercial integrations. The only messaging-adjacent official access is the Compliance API, which is closed and read-and-archive only. Anything sold as a LinkedIn messaging API runs on a logged-in session outside LinkedIn's terms and will get the account restricted.

Even page metrics need Community Management API approval: an access form, a downloadable screencast of the integration, and a live Technical Sign-Off demo. Months, for follower counts.

The UI already renders LinkedIn as a dimmed card with an "API closed" chip and a deep link out. Leave it that way.

---

## 9. API contract

Every route requires a session. API routes 401 as JSON, page routes redirect to `/login`.

```
GET    /api/health                                    open, for Railway

GET    /api/accounts                                  mail + calendar connections
POST   /api/accounts/:id            { label?, color? }
DELETE /api/accounts/:id

GET    /api/mail?folder=&account=&limit=
GET    /api/mail/:accountId/:messageId
POST   /api/mail/:accountId/:messageId/read     { read }
POST   /api/mail/:accountId/:messageId/star     { star }
POST   /api/mail/:accountId/:messageId/move     { folder }
DELETE /api/mail/:accountId/:messageId
POST   /api/mail/:accountId/send                { to, subject, body, replyTo? }

GET    /api/calendar?from=&to=&account=

GET    /api/ghl/locations
POST   /api/ghl/locations           { locationId, token, label, color }
DELETE /api/ghl/locations/:id
GET    /api/ghl/leads?location=&stage=
GET    /api/ghl/leads/:id/thread
POST   /api/ghl/leads/:id/message   { channel, body }
PATCH  /api/ghl/leads/:id           { stage?, name?, phone?, email?, owner? }
POST   /webhooks/ghl                                  signature-verified, no session

GET    /api/social?range=
GET    /api/social/ads?range=
GET    /api/social/posts?range=
GET    /webhooks/meta                                 hub.challenge echo
POST   /webhooks/meta                                 signature-verified
```

### Shapes

The frontend arrays these fill, in order: `ACCOUNTS`, `MAIL`, `EVENTS`, `LOCATIONS`, `LEADS`, `THREADS`, `SOCIAL`, `ADS`, `POSTS`.

```js
// ACCOUNTS  (mail + calendar; one entry is both)
{ id, provider, email, label, color, status }

// MAIL
{ id, acct, folder, from, addr, subject, snippet, body, time, sortKey, unread, star, reply }
//   folder: inbox|drafts|trash|spam|archive
//   time is preformatted for display: "08:12", "Yesterday", "Aug 14"
//   sortKey is epoch ms, used for merge ordering

// EVENTS
{ id, cal, title, location, attendees, start, end, allDay }
//   cal === an ACCOUNTS id. start/end must be Date objects, the grid does maths on them.

// LOCATIONS  (GHL sub-accounts)
{ id, name, short, color, status }
//   id === the GHL locationId

// LEADS
{ id, loc, name, phone, email, source, stage, value, owner, tags,
  last, sortKey, unread, created, ghlId }
//   stage: new|contacted|qualified|proposal|won|lost

// THREADS   keyed by lead id
{ dir: 'in'|'out', channel: 'sms'|'email'|'wa'|'fb', body, day, time }

// SOCIAL
{ platform, handle, followers, followerDelta, reach, views, engagement, status }
//   platform: facebook|instagram|youtube|x
//   engagement is a percentage: interactions / reach * 100

// ADS
{ spend, results, resultsDelta, cplDelta, reach,
  campaigns: [{ name, objective, spend, results, status }] }

// POSTS
{ platform, title, when, reach, views, shares }
```

---

## 10. Frontend wiring

Edit `public/index.html` in place. Do not restyle anything.

Replace the demo arrays with a loader per view. Parse calendar `start`/`end` into `Date` objects on arrival or the time grid breaks silently on strings.

Actions become optimistic: mutate local state, render, fire the fetch, revert and show an error on failure. Every action handler already mutates local state, so you are inserting the fetch, not rewriting the handler.

`saveAccount()` currently pushes into an array. It should redirect, carrying the label and colour so the account arrives already named:

```js
window.location = '/connect/' + provider.toLowerCase()
  + '?label=' + encodeURIComponent(label)
  + '&color=' + encodeURIComponent(color);
```

`ldSave()` should POST to `/api/ghl/locations` and show the server's verification error inline rather than pushing locally.

On load, read `location.hash` for `?connected=` or `?error=`, show a one-line banner, then strip the query so a refresh does not repeat it.

**Delete the demo switch before shipping.** `buildDemo()`, `clearDemo()`, `toggleDemo()` and both Demo data buttons. Keep every empty state, those are load-bearing.

---

## 11. Acceptance tests

Stop at the first failure.

1. With `AUTH_MODE=open`, the root URL loads the dashboard directly with no redirect, and the rail footer shows the unprotected indicator. With `remember`, one sign-in per browser and the cookie survives a restart.
2. Inbox empty state shows with a Connect button.
3. Connect one Google account. Real mail appears with the label and colour you chose.
4. **Connect a second, different Google account.** The chooser appears and lets you pick a different address. Both show separately. *This catches a missing `select_account`.*
5. Connect a Microsoft account. Same.
6. Open a message: marks read, count drops, still read after refresh.
7. Archive a message: leaves Open, appears under Archive, and **has moved in the provider's own web client too**.
8. Drafts, Trash and Spam each show real content from the right folder.
9. Calendar shows every connected account as a colour toggle with **no extra connect step**. Toggling one recalculates the open blocks.
10. Restart the server. Everything survives.
11. Paste a GHL PIT. Bad token gives a specific inline error. Good token connects and leads load.
12. Connect a **second** GHL sub-account. Both appear in the submenu with separate counts.
13. Send a message to a lead. It appears in GHL's own conversation view.
14. Change a lead's stage in **GHL's UI**. Within the webhook delay it updates in the dashboard **without a refresh**.
15. Send a message from the dashboard and confirm it appears **once**, not twice. *This catches missing echo suppression.*
16. Kill one connection's token by hand. Its sidebar entry goes red, every other connection still loads.
17. Deploy to Railway, repeat 3, 4, 11 and 12 against the live domain.

---

## 12. Ground rules

Do not touch the CSS or the layout. The design is settled.

Do not add TypeScript, a bundler, a framework or an ORM.

Never invent fallback data. If a source fails, the UI says so. A plausible-looking number from nowhere is worse than an error.

Never build a card for a metric in the deprecated list in section 5. It will look like it works and return nothing.

Commit in logical chunks with real messages.

Stop and ask rather than guessing, particularly on scope selection, since that decides whether we end up in a review process we do not want.
