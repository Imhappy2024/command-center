# Command Center

Single-pane operations dashboard — inbox, tasks, and automation health pulled from live
sources, with six further views still on placeholder markup.

## What is actually wired

| View | Source | State |
|---|---|---|
| Overview | ClickUp + mail + Outlook calendar + n8n | live |
| Inbox | Outlook or Gmail | live |
| Calendar | Outlook via Microsoft Graph | live |
| Tasks | ClickUp | live |
| Systems | n8n | live |
| Leads | — | placeholder, needs GoHighLevel |
| Properties | — | placeholder, Supabase not wired |
| Financial | — | placeholder |
| Social | — | placeholder |
| Notes | — | placeholder |

With no credentials set the wired views say **"not configured"** and name the variable
they need. They never show a fabricated number.

## Mail

The Inbox is a working mail client across every connected account:

- **Read** — click any row for the full message. HTML mail renders in a sandboxed
  iframe with no script execution, because mail is hostile input.
- **Compose** — the *Compose* button, with a From picker listing every connected mailbox.
- **Reply** — from an open message, quoting the original and threading correctly.
- **Drafts** — *Save draft* writes to that account's Drafts folder.
- **Act** — mark read/unread, archive, trash; per-row on hover or from the reader.

`⌘/Ctrl+Enter` sends, `Esc` closes.

Scopes are `gmail.modify` + `gmail.compose` and `Mail.ReadWrite` + `Mail.Send`. Accounts
connected before sending existed are read-only until reconnected — a refresh token carries
the scopes it was minted with and cannot be widened.

## Connecting accounts

Sign in, click **Connect** — on the empty Inbox, the empty Calendar, or the
**Connections** page — approve at Google or Microsoft, done. Tokens are encrypted with
AES-256-GCM and stored server-side; the browser only ever holds a session cookie.

**As many mailboxes as you like, from either provider.** Accounts are keyed by address,
so connecting a second one adds rather than replaces. Use **Add account** on the
Connections page, or **Add another mailbox** at the foot of a populated Inbox or Calendar.
The Inbox merges every connected mailbox into one list, newest first, tagging each message
with the account it came from; the counters sum across all of them. Calendars merge the
same way, and free/busy treats you as busy if *any* connected calendar is busy.

`MAIL_SOURCE` defaults to `all`. Set it to `outlook` or `gmail` to narrow the Inbox to one
provider. Disconnecting is per-account, not per-provider.

This is the delegated OAuth flow — you approve access to your own mailbox. It needs no
Workspace domain-wide delegation and no Entra admin consent for application permissions,
which is why it exists alongside the environment-variable paths below. A connected
account always wins over the equivalent variables.

Two things it needs:

| Requirement | Why |
|---|---|
| Provider client id + secret | `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, `MS_CLIENT_ID`/`MS_CLIENT_SECRET`. The Connections page prints the exact redirect URI to register. |
| `DATA_DIR` on a volume | Railway's filesystem is ephemeral. Without a mounted volume, a redeploy drops the tokens and you reconnect. The page warns when this is unset. |

Tokens are always encrypted at rest. The key comes from `ENCRYPTION_KEY`, else `APP_PASSWORD`,
else one generated under `DATA_DIR` on first boot — so no configuration is required to connect.

Register the redirect URI shown on the Connections page — `https://<your-domain>/oauth/callback/google`
and `.../microsoft`. Google's client must be of type **Web application**, not Desktop.
Microsoft's goes under **Authentication → Web**.

## Run locally

```bash
npm install
cp .env.example .env      # fill in what you have
npm run dev               # http://localhost:3000
```

`npm run refresh` regenerates `data/dashboard.json` once and prints per-source status.

## Deploy to Railway

1. Railway → **New Project → Deploy from GitHub repo** → this repo.
2. **Variables** → add the ones below (all optional; add only the sources you want).
3. **Settings → Networking → Generate Domain**.

Nixpacks detects Node, runs `npm install`, then `npm start`. `railway.json` points the
health check at `/api/health`.

### Variables

Nothing is required to boot. `PORT` is injected by Railway — do not set it.

**Access** — set these first

| Variable | Required | Notes |
|---|---|---|
| `APP_PASSWORD` | no | Adds a login screen. Unset means the dashboard — and every mailbox on it — is open to anyone with the URL |
| `PUBLIC_URL` | recommended | e.g. `https://command-center.up.railway.app`; providers match redirect URIs exactly |
| `DATA_DIR` | recommended | Mounted volume path, e.g. `/data`; without it connections die on redeploy |
| `ENCRYPTION_KEY` | no | Pins the token-store key. Otherwise `APP_PASSWORD`, else auto-generated under `DATA_DIR` |
| `SESSION_SECRET` | no | Pins the session signing key across a password change |

**ClickUp** — ClickUp → Settings → Apps → *API Token*

| Variable | Required | Notes |
|---|---|---|
| `CLICKUP_TOKEN` | for ClickUp | Personal token, starts with `pk_` |
| `CLICKUP_TEAM_ID` | no | Defaults to your first team |
| `CLICKUP_USER_ID` | no | Defaults to you; set to scope tasks to someone else |

**n8n** — n8n → Settings → *n8n API* → create an API key

| Variable | Required | Notes |
|---|---|---|
| `N8N_BASE_URL` | for n8n | Instance root, e.g. `https://n8n.example.com` — no `/api/v1` |
| `N8N_API_KEY` | for n8n | Sent as `X-N8N-API-KEY` |

**Gmail** — two paths, pick one. Scope is `gmail.readonly` either way.

*(a) Service account* — no token expiry, no consent screen, survives password changes.
Requires **Google Workspace**; it cannot work against a consumer `@gmail.com` mailbox.

| Variable | Required | Notes |
|---|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | for this path | The whole key JSON on one line, or base64-encoded |
| `GOOGLE_IMPERSONATE_USER` | **yes** | Mailbox to read, e.g. `you@yourdomain.com` |

A service account owns no mailbox — it reads someone else's by impersonation, which a
Workspace super-admin must authorise once:

1. Google Cloud Console → enable the **Gmail API** on the service account's project.
2. `admin.google.com` → Security → Access and data control → API controls →
   **Domain-wide delegation** → *Add new*.
3. Client ID: the `client_id` from the JSON. Scope: `https://www.googleapis.com/auth/gmail.readonly`.

Run `npm run check:google` — it prints the exact client id and scope to paste into step 3,
then tries a real call and reports what came back.

*(b) OAuth refresh token* — works on consumer Gmail, no admin needed.

| Variable | Required | Notes |
|---|---|---|
| `GOOGLE_CLIENT_ID` | for this path | Desktop-app OAuth client |
| `GOOGLE_CLIENT_SECRET` | for this path | |
| `GOOGLE_REFRESH_TOKEN` | for this path | From `npm run auth:google` |

```bash
# Cloud Console: enable the Gmail API, create a Desktop-app OAuth client,
# add your address under OAuth consent screen -> Test users.
$env:GOOGLE_CLIENT_ID='...'
$env:GOOGLE_CLIENT_SECRET='...'
npm run auth:google         # opens a URL, prints GOOGLE_REFRESH_TOKEN
```

If `GOOGLE_SERVICE_ACCOUNT_JSON` is set it wins; the OAuth variables are ignored.

**Microsoft Graph** — Outlook calendar, mail and contacts, app-only

| Variable | Required | Notes |
|---|---|---|
| `MS_TENANT_ID` | for Outlook | Directory (tenant) ID |
| `MS_CLIENT_ID` | for Outlook | Application (client) ID |
| `MS_CLIENT_SECRET` | for Outlook | Client secret *value*, not the secret ID |
| `MS_SERVICE_USER` | for Outlook | Mailbox UPN to read, e.g. `you@yourdomain.com` |

This is the client-credentials flow: the app authenticates as itself, so it needs
**Application** permissions with admin consent — *not* Delegated ones:

1. Entra ID → App registrations → your app → **API permissions**.
2. Add a permission → Microsoft Graph → **Application permissions** →
   `Calendars.Read`, `Mail.Read`, `Contacts.Read`.
3. **Grant admin consent**.

Consent is per-permission, so calendar can work while mail is denied. When that happens
the connection rail says "Outlook mail denied" and the Calendar view still renders.

Application-scope `Mail.Read` reaches **every mailbox in the tenant**. Scope it down with
an [application access policy](https://learn.microsoft.com/en-us/graph/auth-limit-mailbox-access)
if that is wider than you want.

**Behaviour**

| Variable | Default | Notes |
|---|---|---|
| `REFRESH_INTERVAL_MINUTES` | `15` | `0` disables the timer; boot refresh still runs |
| `AGENT_TIMEZONE` | `UTC` | IANA zone for calendar times, e.g. `America/Chicago` |
| `MAIL_SOURCE` | `all` | `all` merges every connected mailbox; `outlook` or `gmail` narrows to one provider |
| `OWNER_NAME` | ClickUp username | Name in the greeting |
| `DATA_FILE` | `./data/dashboard.json` | Absolute path override |

## Layout

```
server.js                  Express: auth gate, static, /api/data, /api/health, scheduler
lib/session.mjs            Signed-cookie sessions and the password gate
lib/store.mjs              AES-256-GCM encrypted token store
lib/providers.mjs          OAuth provider definitions, code exchange, token refresh
lib/routes.mjs             /login, /connect/:p, /oauth/callback/:p, /api/connections
scripts/refresh.mjs        Composes the payload from whatever has credentials
scripts/sources/*.mjs      One module per source; each degrades independently
scripts/auth-google.mjs    One-time Gmail refresh-token helper (env-var path)
scripts/check-google.mjs   Validates Gmail credentials, prints delegation values
public/index.html          Shell and all eleven views
public/login.html          Sign-in page
public/app.js              Nav, routing, clock, hydration, Connections screen
data/dashboard.json        Generated payload; committed as the unconfigured state
```

## How refresh works

`runRefresh()` calls every source in parallel. Each returns `ok`, `unconfigured`, or
`error`, and the composed payload carries a `sources` block recording which was which.
`source` is then `live` (all up), `partial` (some up), or `unconfigured` (none).

The server refreshes on boot and every `REFRESH_INTERVAL_MINUTES` when at least one
credential is present. The browser re-fetches `/api/data` every 5 minutes. A source that
throws is reported in the connection rail rather than taking down the page.

## API

| Route | Returns |
|---|---|
| `GET /api/health` | `{ ok, uptime, ts }` — Railway's health-check target |
| `GET /api/data` | The payload; `503` if the file is missing or malformed |

## Known gaps

- **Leads** — needs GoHighLevel. GHL already appears in several n8n workflows, so routing
  it through n8n may be cheaper than a direct integration.
- **Contacts** — Graph returns a count only; nothing renders it yet.
- **Properties / Financial** — the `LW Data base` Supabase project is the obvious source;
  no schema mapping written yet.
- **Social** — needs per-platform tokens.
- n8n execution history is sampled at 250 records; the Systems panel marks the count with
  `+` when it hits that ceiling.
- The Tasks checkboxes are display-only — ticking one does not write back to ClickUp.
