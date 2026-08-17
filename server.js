import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { migrate, close } from './db/index.js';
import { initCrypto } from './lib/crypto.js';
import { createApp } from './lib/app.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const env = process.env;
const PORT = Number(env.PORT) || 3000;

/* Half-configured is worse than not running: without APP_PASSWORD the dashboard
   is open to anyone who finds the URL, and without ENCRYPTION_KEY there is
   nowhere safe to put a refresh token. Name the variable and stop. */
const REQUIRED = ['APP_PASSWORD', 'SESSION_SECRET', 'ENCRYPTION_KEY', 'DATABASE_URL'];
const missing = REQUIRED.filter(name => !env[name]);
if (missing.length) {
  console.error('Cannot start. Missing required environment variable(s):');
  for (const name of missing) console.error(`  - ${name}`);
  console.error('\nSet them in Railway under Variables, or in .env for a local run.');
  console.error('See .env.example for what each one is for.');
  process.exit(1);
}

for (const name of ['SESSION_SECRET', 'ENCRYPTION_KEY']) {
  if (env[name].length < 32) {
    console.error(`${name} must be at least 32 characters. Generate one with:`);
    console.error('  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
    process.exit(1);
  }
}

initCrypto(env.ENCRYPTION_KEY);

try {
  await migrate();
} catch (err) {
  console.error('Cannot start. Database migration failed:', err.message);
  console.error('Check DATABASE_URL points at a reachable Postgres instance.');
  process.exit(1);
}

const app = createApp({ env, publicDir: PUBLIC });

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Command Center listening on 0.0.0.0:${PORT}`);
  console.log('  login:    APP_PASSWORD set');
  console.log('  tokens:   Postgres, AES-256-GCM at rest');
  console.log(`  origin:   ${env.PUBLIC_URL || '(derived from request headers — set PUBLIC_URL in production)'}`);
  for (const [name, id] of [['Google', 'GOOGLE_CLIENT_ID'], ['Microsoft', 'MS_CLIENT_ID']]) {
    console.log(`  ${name.padEnd(9)} ${env[id] ? 'configured' : 'not configured'}`);
  }
  console.log('  IMAP      always available (host and app password entered per mailbox)');
});

/* Railway sends SIGTERM on redeploy. Draining first means an in-flight token
   refresh finishes writing rather than leaving a half-updated row behind. */
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down`);
    server.close(async () => { await close(); process.exit(0); });
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
