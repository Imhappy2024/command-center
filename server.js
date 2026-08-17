import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { migrate, close } from './db/index.js';
import { initCrypto } from './lib/crypto.js';
import { createApp } from './lib/app.js';
import { AUTH_MODES, normaliseMode } from './lib/session.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const env = process.env;
const PORT = Number(env.PORT) || 3000;

const die = (...lines) => {
  for (const line of lines) console.error(line);
  process.exit(1);
};

const AUTH_MODE = normaliseMode(env.AUTH_MODE);
if (!AUTH_MODE) {
  die(`AUTH_MODE must be one of: ${AUTH_MODES.join(', ')} — got "${env.AUTH_MODE}".`,
      'Leave it unset to default to remember.');
}
env.AUTH_MODE = AUTH_MODE;

/* Railway injects RAILWAY_PUBLIC_DOMAIN once a domain is generated, and it is
   exactly the origin OAuth redirect URIs must be built from. Deriving it means
   one less variable to set by hand, and no chance of a trailing slash or the
   wrong scheme — the two things that produce redirect_uri_mismatch. */
if (!env.PUBLIC_URL && env.RAILWAY_PUBLIC_DOMAIN) {
  env.PUBLIC_URL = `https://${env.RAILWAY_PUBLIC_DOMAIN}`;
  console.log(`PUBLIC_URL not set — derived ${env.PUBLIC_URL} from RAILWAY_PUBLIC_DOMAIN`);
}

/* APP_PASSWORD is required only by the modes that actually check it. Demanding
   it under AUTH_MODE=open is what locked the owner out of his own dashboard. */
const REQUIRED = [
  'SESSION_SECRET',
  'ENCRYPTION_KEY',
  'PUBLIC_URL',
  'DATABASE_URL',
  ...(AUTH_MODE === 'open' ? [] : ['APP_PASSWORD'])
];

const missing = REQUIRED.filter(name => !env[name]);
if (missing.length) {
  die('Cannot start. Missing required environment variable(s):',
      ...missing.map(name => `  - ${name}`),
      '',
      `AUTH_MODE is "${AUTH_MODE}".`
        + (AUTH_MODE === 'open'
            ? ' APP_PASSWORD is not required in this mode.'
            : ' Set AUTH_MODE=open to drop the login and stop needing APP_PASSWORD.'),
      '',
      'Set them in Railway under Variables, or in .env for a local run.',
      'See .env.example for what each one is for.');
}

for (const name of ['SESSION_SECRET', 'ENCRYPTION_KEY']) {
  if (env[name].length < 32) {
    die(`${name} must be at least 32 characters. Generate one with:`,
        '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  }
}

if (/\/$/.test(env.PUBLIC_URL)) {
  // Providers match redirect URIs byte for byte, and a trailing slash is a mismatch.
  env.PUBLIC_URL = env.PUBLIC_URL.replace(/\/+$/, '');
}

initCrypto(env.ENCRYPTION_KEY);

try {
  await migrate();
} catch (err) {
  die('Cannot start. Database migration failed: ' + err.message,
      'Check DATABASE_URL points at a reachable Postgres instance.');
}

const app = createApp({ env, publicDir: PUBLIC });

const server = app.listen(PORT, '0.0.0.0', () => {
  const gate = {
    open: 'OPEN — no login, anyone with the URL can read connected mail',
    remember: 'remember — one sign-in per browser, 365-day sliding cookie',
    password: 'password — 14-day cookie'
  }[AUTH_MODE];

  console.log(`Command Center listening on 0.0.0.0:${PORT}`);
  console.log(`  auth:     ${gate}`);
  console.log('  tokens:   Postgres, AES-256-GCM at rest');
  console.log(`  origin:   ${env.PUBLIC_URL}`);
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
