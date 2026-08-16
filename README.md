# Command Center

Single-pane operations dashboard — inbox, tasks, and automation health pulled from live
sources, with six further views still on placeholder markup.

## What is actually wired

| View | Source | State |
|---|---|---|
| Overview | ClickUp + Gmail + n8n | live |
| Inbox | Gmail | live |
| Tasks | ClickUp | live |
| Systems | n8n | live |
| Calendar | — | placeholder, no connector |
| Leads | — | placeholder, needs GoHighLevel |
| Properties | — | placeholder, Supabase not wired |
| Financial | — | placeholder |
| Social | — | placeholder |
| Notes | — | placeholder |

With no credentials set the wired views say **"not configured"** and name the variable
they need. They never show a fabricated number.

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

**Gmail** — the only one that needs an OAuth round trip

| Variable | Required | Notes |
|---|---|---|
| `GOOGLE_CLIENT_ID` | for Gmail | Desktop-app OAuth client |
| `GOOGLE_CLIENT_SECRET` | for Gmail | |
| `GOOGLE_REFRESH_TOKEN` | for Gmail | From `npm run auth:google` |

To mint the refresh token, once, on your own machine:

```bash
# Google Cloud Console: enable the Gmail API, create a Desktop-app OAuth client,
# then add your own address under OAuth consent screen -> Test users.
$env:GOOGLE_CLIENT_ID='...'
$env:GOOGLE_CLIENT_SECRET='...'
npm run auth:google         # opens a URL, prints GOOGLE_REFRESH_TOKEN
```

Scope requested is `gmail.readonly`. Paste the printed token into Railway.

**Behaviour**

| Variable | Default | Notes |
|---|---|---|
| `REFRESH_INTERVAL_MINUTES` | `15` | `0` disables the timer; boot refresh still runs |
| `OWNER_NAME` | ClickUp username | Name in the greeting |
| `DATA_FILE` | `./data/dashboard.json` | Absolute path override |

## Layout

```
server.js                  Express: static + /api/data + /api/health, refresh scheduler
scripts/refresh.mjs        Composes data/dashboard.json from whatever has credentials
scripts/sources/*.mjs      One module per source; each degrades independently
scripts/auth-google.mjs    One-time Gmail refresh-token helper
public/index.html          Shell and all ten views
public/app.js              Nav, routing, clock, hydration
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

- **Calendar** — needs Google Calendar API credentials; nothing is wired.
- **Leads** — needs GoHighLevel. GHL already appears in several n8n workflows, so routing
  it through n8n may be cheaper than a direct integration.
- **Properties / Financial** — the `LW Data base` Supabase project is the obvious source;
  no schema mapping written yet.
- **Social** — needs per-platform tokens.
- n8n execution history is sampled at 250 records; the Systems panel marks the count with
  `+` when it hits that ceiling.
- The Tasks checkboxes are display-only — ticking one does not write back to ClickUp.
