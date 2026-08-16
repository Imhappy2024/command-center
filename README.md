# Command Center

Single-pane operations dashboard — inbox, calendar, tasks, leads, properties, financials,
social and automation health in one view.

## Status

The shell is complete and deployable. The **Overview** view and the connection rail render
from `/api/data`; the other eight views are still static markup pending real sources.

`data/dashboard.json` currently ships `"source": "demo"` — the UI labels itself
**"Demo data · no live sources"** so a deployed build never passes placeholder numbers off
as real.

## Run locally

```bash
npm install
npm run dev          # http://localhost:3000
```

## Deploy to Railway

1. Push this repo to GitHub.
2. Railway → **New Project → Deploy from GitHub repo** → pick this repo.
3. Nothing else to configure. Nixpacks detects Node, runs `npm install`, then `npm start`.
   `railway.json` sets the health check to `/api/health`.
4. **Settings → Networking → Generate Domain** to get a public URL.

Railway injects `PORT`; the server binds `0.0.0.0:$PORT`. No secrets are required to boot.

| Variable    | Required | Default              | Notes                                  |
|-------------|----------|----------------------|----------------------------------------|
| `PORT`      | no       | `3000`               | Railway sets this automatically        |
| `DATA_FILE` | no       | `./data/dashboard.json` | Absolute path to an alternate payload |

## Layout

```
server.js              Express: static + /api/data + /api/health
public/index.html      Shell and all ten views
public/app.js          Nav, routing, clock, and Overview hydration
data/dashboard.json    The payload /api/data serves
railway.json           Build and health-check config
```

## API

| Route         | Returns                                                     |
|---------------|-------------------------------------------------------------|
| `GET /api/health` | `{ ok, uptime, ts }` — Railway's health check target      |
| `GET /api/data`   | The dashboard payload; `503` if the file is missing or malformed |

The frontend fetches `/api/data` on load and every 5 minutes. If the request fails it keeps
the static markup and flags the header chip **"Data source unreachable"** rather than
rendering empty cards.

## Wiring real data

`data/dashboard.json` is the single seam. Anything that can write that file — a cron job, an
n8n workflow, a scheduled agent — makes the dashboard live without touching the frontend.

Connector status as of this commit:

| Source          | Available | Note                                           |
|-----------------|-----------|------------------------------------------------|
| Gmail           | yes       | inbox counts, threads awaiting reply            |
| ClickUp         | yes       | tasks, due dates, list rollups                  |
| n8n             | yes       | workflow list, execution history, failure counts |
| Supabase        | yes       | properties / listings table                     |
| Google Drive    | yes       | document checks                                 |
| Google Calendar | no        | no connector — needs Calendar API credentials   |
| GoHighLevel     | no        | no connector — needs a GHL API key              |
| Social platforms| no        | needs per-platform tokens                       |

Next step is a `scripts/refresh.mjs` that pulls from the available sources, writes
`data/dashboard.json` with `"source": "live"`, and runs on a schedule.
