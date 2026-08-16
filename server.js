import express from 'express';
import compression from 'compression';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runRefresh } from './scripts/refresh.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA_FILE = process.env.DATA_FILE || path.join(ROOT, 'data', 'dashboard.json');
const PORT = Number(process.env.PORT) || 3000;
const REFRESH_MINUTES = Number(process.env.REFRESH_INTERVAL_MINUTES ?? 15);
const HAS_SOURCE = Boolean(
  process.env.CLICKUP_TOKEN ||
  process.env.N8N_API_KEY ||
  process.env.GOOGLE_REFRESH_TOKEN ||
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON ||
  process.env.MS_CLIENT_SECRET
);

const app = express();
app.disable('x-powered-by');
app.use(compression());

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()), ts: new Date().toISOString() });
});

app.get('/api/data', async (req, res) => {
  try {
    const raw = await readFile(DATA_FILE, 'utf8');
    JSON.parse(raw); // fail loudly on malformed data rather than shipping it
    res.set('Cache-Control', 'no-store').type('application/json').send(raw);
  } catch (err) {
    console.error('[api/data]', err.message);
    res.status(503).json({ error: 'dashboard data unavailable' });
  }
});

app.use(express.static(PUBLIC, {
  extensions: ['html'],
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  }
}));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not found' });
  res.status(200).sendFile(path.join(PUBLIC, 'index.html'));
});

async function refresh(reason){
  try {
    const { summary, payload } = await runRefresh({ out: DATA_FILE });
    console.log(`[refresh:${reason}] ${summary} -> source=${payload.source}`);
  } catch (err) {
    console.error(`[refresh:${reason}] failed:`, err.message);
  }
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Command Center listening on 0.0.0.0:${PORT}`);
  console.log(`  data file: ${DATA_FILE}`);

  if (!HAS_SOURCE) {
    console.log('  no source credentials set — serving data/dashboard.json as committed');
    return;
  }
  refresh('boot');
  if (REFRESH_MINUTES > 0) {
    console.log(`  refreshing every ${REFRESH_MINUTES}m`);
    setInterval(() => refresh('interval'), REFRESH_MINUTES * 60_000).unref();
  }
});
