# Command Center

Single-pane operations dashboard. Ten views; the Inbox is a working multi-account mail
client, the rest are empty states until their sources are wired.

Nothing fabricates data. A view with no source says so and names what it needs.

## What is wired

| View | Source | State |
|---|---|---|
| Inbox | Gmail, Microsoft Graph, IMAP | live |
| Calendar | Google Calendar, Graph — `/api/calendar` serves it | **backend only**, frontend loader not yet written |
| Overview, Tasks, Notes, Leads, Properties, Financial, Social, Systems | — | empty states |

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
| `APP_PASSWORD` | Gates the whole dashboard. Without it anyone with the URL could connect a mailbox or read one already connected |
| `SESSION_SECRET` | 32+ chars. Signs session and OAuth state cookies |
| `ENCRYPTION_KEY` | 32+ chars. Encrypts refresh tokens and app passwords. Changing it makes every stored credential undecryptable |
| `DATABASE_URL` | Injected by Railway's Postgres plugin |

**Deployment**

| Variable | Notes |
|---|---|
| `PUBLIC_URL` | e.g. `https://command-center.up.railway.app`, no trailing slash. Set it: Railway's proxy reports `http` in `req.protocol`, so a header-derived redirect URI will not match what you registered |
| `PORT` | Injected by Railway. Only set it locally |

**Providers** — omit a pair and that provider shows as unavailable in the connect dialog,
with the variable it needs.

| Variable | Notes |
|---|---|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Web application client |
| `MS_CLIENT_ID` / `MS_CLIENT_SECRET` | Secret **value** |
| `MS_TENANT_ID` | `common` supports work and personal accounts |

**Behaviour**

| Variable | Default | Notes |
|---|---|---|
| `MAIL_FETCH_LIMIT` | `25` | Per mailbox per folder, before merging |
| `AGENT_TIMEZONE` | server zone | IANA zone deciding whether a row shows a clock, `Yesterday` or a date |
| `PGSSLMODE` | — | `disable` if your Postgres rejects TLS. Railway's private hostname is detected automatically |

## Layout

```
server.js                  Boot checks, migrate, listen
lib/app.js                 Express assembly, mountable without a database
lib/crypto.js              AES-256-GCM for stored credentials
lib/session.js             Signed-cookie sessions, password gate, PKCE helpers
lib/oauth.js               Provider config, code exchange, token refresh
lib/accounts.js            accounts CRUD and getAccessToken()
lib/normalise.js           Shared message and event shaping
db/schema.sql              accounts table; re-applied every boot
db/index.js                pg pool, query helper, migration runner
providers/index.js         Dispatch by provider
providers/google.js        Gmail + Google Calendar
providers/microsoft.js     Graph mail + calendarView
providers/imap.js          IMAP + SMTP
routes/auth.js             /login, /logout
routes/connect.js          /connect/:provider, /oauth/callback/:provider, /api/accounts
routes/mail.js             /api/mail and the actions
routes/calendar.js         /api/calendar
routes/guard.js            Turns a database outage into a 503, not a crash
public/index.html          Shell, all ten views, Inbox logic
public/login.html          Sign-in page
```

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

- **Calendar frontend.** `/api/calendar` works; `public/index.html` has no calendar loader
  yet. Its Calendar view is still an empty state.
- **Nine views are empty states.** Overview, Tasks, Notes, Leads, Properties, Financial,
  Social and Systems have no source wired.
- **No draft saving.** There is no draft-write endpoint, so the reader has no *Save draft*
  button. Gmail's `drafts.create` and Graph's `POST /me/messages` would both do it.
- **Nothing routes mail to ClickUp.** The mockup's *Send to ClickUp* button is gone rather
  than faked. `scripts/sources/clickup.mjs` still holds a working client.
- **Archive has no cheap count on Gmail**, because it is defined by the absence of a label
  rather than the presence of one. It reports `null` and the sidebar shows blank.
- **IMAP opens a connection per operation.** Fine for one user; it adds about a second to
  each call.
- **The snapshot pipeline is parked.** `scripts/refresh.mjs`, `scripts/sources/*` and
  `lib/*.mjs` still hold the ClickUp, n8n and calendar collectors that fed
  `data/dashboard.json`. Nothing imports them, and they still read the old encrypted-file
  token store, so they will not run as-is. They are kept because they are the shortest
  path to wiring the remaining views; repointing them at Postgres is the work.
- **`public/app.js` is orphaned** — the previous dashboard's logic, superseded by the
  inline script in `index.html`. Retained, not referenced.
