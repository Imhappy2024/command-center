import express from 'express';
import compression from 'compression';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA_FILE = process.env.DATA_FILE || path.join(ROOT, 'data', 'dashboard.json');
const PORT = Number(process.env.PORT) || 3000;

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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Command Center listening on 0.0.0.0:${PORT}`);
  console.log(`  data file: ${DATA_FILE}`);
});
