import express from 'express';
import compression from 'compression';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { runRefresh } from './scripts/refresh.mjs';
import { TokenStore, resolveSecret } from './lib/store.mjs';
import { makeAuth } from './lib/session.mjs';
import { mountRoutes } from './lib/routes.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const env = process.env;

const DATA_DIR = env.DATA_DIR || path.join(ROOT, 'data');
const DATA_FILE = env.DATA_FILE || path.join(DATA_DIR, 'dashboard.json');
const PORT = Number(env.PORT) || 3000;
const REFRESH_MINUTES = Number(env.REFRESH_INTERVAL_MINUTES ?? 15);

const secret = await resolveSecret(env, DATA_DIR);
const store = new TokenStore({
  file: env.TOKEN_STORE || path.join(DATA_DIR, 'connections.enc'),
  secret
});

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(compression());

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

/* Optional. With no APP_PASSWORD the dashboard is open and connecting still
   works — the password gates who can open the page, not whether the feature
   exists. */
const auth = makeAuth({
  password: env.APP_PASSWORD,
  secret: env.SESSION_SECRET || secret,
  isSecure: () => String(env.PUBLIC_URL || '').startsWith('https:') || env.NODE_ENV === 'production'
});

/* Health stays open so Railway can reach it without a session. */
app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()), ts: new Date().toISOString() });
});

mountRoutes(app, {
  env,
  auth,
  store,
  secret,
  publicDir: PUBLIC,
  onConnected: () => refresh('connect')
});

app.get('/api/data', auth.require, async (req, res) => {
  try {
    const raw = await readFile(DATA_FILE, 'utf8');
    JSON.parse(raw); // fail loudly on malformed data rather than shipping it
    res.set('Cache-Control', 'no-store').type('application/json').send(raw);
  } catch (err) {
    console.error('[api/data]', err.message);
    res.status(503).json({ error: 'dashboard data unavailable' });
  }
});

/* login.html must stay reachable while signed out; everything else is gated. */
app.use('/login.html', (req, res) => res.redirect('/login'));
app.use(auth.require, express.static(PUBLIC, {
  extensions: ['html'],
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  }
}));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not found' });
  if (!auth.valid(req)) return res.redirect('/login');
  res.status(200).sendFile(path.join(PUBLIC, 'index.html'));
});

let refreshing = null;
async function refresh(reason){
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const { summary, payload } = await runRefresh({ env, out: DATA_FILE, store });
      console.log(`[refresh:${reason}] ${summary} -> source=${payload.source}`);
    } catch (err) {
      console.error(`[refresh:${reason}] failed:`, err.message);
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`Command Center listening on 0.0.0.0:${PORT}`);
  console.log(`  data dir:  ${DATA_DIR}`);
  console.log(`  login:     ${auth.enabled ? 'APP_PASSWORD set' : 'OPEN — anyone with the URL can read connected mail'}`);
  console.log(`  connect:   ${store.enabled ? 'enabled' : 'disabled — no encryption key'}`);

  const connected = Object.keys(await store.all()).filter(k => k.startsWith('oauth:'));
  if (connected.length) console.log(`  connected: ${connected.map(k => k.slice(6)).join(', ')}`);

  /* Always write a payload on boot, even with nothing configured. DATA_FILE may
     sit on a freshly mounted volume where the committed placeholder does not
     exist, and /api/data 503s on a missing file — which would replace the
     Connect UI with "data source unreachable" at exactly the wrong moment. */
  await refresh('boot');

  const hasEnvSource = Boolean(
    env.CLICKUP_TOKEN || env.N8N_API_KEY || env.GOOGLE_REFRESH_TOKEN ||
    env.GOOGLE_SERVICE_ACCOUNT_JSON || env.MS_CLIENT_SECRET
  );
  if (!hasEnvSource && !connected.length) {
    console.log('  no sources yet — connect an account or set source credentials');
    return;
  }

  if (REFRESH_MINUTES > 0) {
    console.log(`  refreshing every ${REFRESH_MINUTES}m`);
    setInterval(() => refresh('interval'), REFRESH_MINUTES * 60_000).unref();
  }
});
