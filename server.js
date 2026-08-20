import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { migrate, close } from './db/index.js';
import { initCrypto } from './lib/crypto.js';
import { createApp } from './lib/app.js';
import { AUTH_MODES, normaliseMode } from './lib/session.js';
import { PROVIDERS, missingVars } from './lib/oauth.js';
import { seedFromEnv } from './lib/ghl-seed.js';

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

/* GHL sub-accounts declared as GHL_TOKEN_* / GHL_LOCATION_* pairs. Runs before
   listen() so the locations exist by the first request, and never fails boot: a
   bad pair is named in the log and skipped. Steady-state redeploys make no API
   calls at all, because an unchanged token is detected without verifying. */
const seed = await seedFromEnv(env);
if (seed.declared) {
  console.log(`GHL env sub-accounts: ${seed.declared} declared, `
    + `${seed.seeded} written, ${seed.skipped} skipped`);
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
  /* Stated at boot rather than left silent. This endpoint writes to the lead
     mirror and takes no secret; the locationId allow-list is what contains it. */
  console.log('  webhooks: /webhooks/ghl OPEN — unauthenticated, allow-listed by locationId');
  console.log(`  ghl sync: reconcile every ${app.locals.background?.intervalMinutes ?? '—'}m, `
    + 'full pass daily');
  console.log(`  social:   poll every ${app.locals.background?.socialMinutes ?? '—'}m `
    + '(platform APIs are never called from a request)');

  /* Reported through missingVars, the same check the connect sheet uses, and
     enumerated from PROVIDERS so a provider added later is covered without
     touching this. Naming the absent variable is the point: "not configured"
     alone sent an hour down the wrong path. */
  const width = Math.max(...Object.values(PROVIDERS).map(p => p.label.length));
  for (const [name, p] of Object.entries(PROVIDERS)) {
    const label = `  ${p.label.padEnd(width)}  `;
    if (!p.oauth) {
      console.log(`${label}no server config — credentials entered per connection`);
      continue;
    }
    const absent = missingVars(name, env);
    console.log(label + (absent.length
      ? `not configured — ${absent.join(' and ')} missing`
      : 'configured'));
  }
});

/* Railway sends SIGTERM on redeploy. Draining first means an in-flight token
   refresh finishes writing rather than leaving a half-updated row behind. */
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down`);
    server.close(async () => {
      /* Before the pool closes: the webhook worker and the reconciler both hold
         queries, and closing under them would leave a batch half applied. */
      await app.locals.background?.stop().catch(() => {});
      await close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
