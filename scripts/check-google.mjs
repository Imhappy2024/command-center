/* Validates Gmail credentials and prints what the Workspace admin needs.
   npm run check:google */

import { parseServiceAccount } from './sources/gmail.mjs';
import { fetchGmail } from './sources/gmail.mjs';

const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const env = process.env;

if (env.GOOGLE_SERVICE_ACCOUNT_JSON) {
  let sa;
  try {
    sa = parseServiceAccount(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } catch (err) {
    console.error('✗ ' + err.message);
    process.exit(1);
  }

  console.log('Service account parsed.');
  console.log('  project      ' + (sa.project_id || '(none)'));
  console.log('  client_email ' + sa.client_email);
  console.log('  client_id    ' + (sa.client_id || '(missing — needed for delegation)'));
  console.log('  impersonate  ' + (env.GOOGLE_IMPERSONATE_USER || '✗ GOOGLE_IMPERSONATE_USER not set'));
  console.log('');
  console.log('Domain-wide delegation, done once by a Workspace super-admin:');
  console.log('  admin.google.com -> Security -> Access and data control -> API controls');
  console.log('  -> Domain-wide delegation -> Add new');
  console.log('    Client ID: ' + (sa.client_id || '<from the JSON>'));
  console.log('    Scopes:    ' + SCOPE);
  console.log('');
} else if (env.GOOGLE_CLIENT_ID) {
  console.log('Using the OAuth refresh-token path.');
  console.log('  refresh token ' + (env.GOOGLE_REFRESH_TOKEN ? 'present' : '✗ missing — run npm run auth:google'));
  console.log('');
} else {
  console.error('✗ No Gmail credentials set.');
  process.exit(1);
}

console.log('Calling Gmail…');
let r;
try {
  r = await fetchGmail(env);
} catch (err) {
  console.error('✗ ' + err.message);
  process.exit(1);
}
if (!r.ok) {
  console.error('✗ ' + r.reason);
  process.exit(1);
}
console.log('✓ ' + r.counts.unreadThreads.toLocaleString() + ' unread of '
  + r.counts.totalThreads.toLocaleString() + ' threads; newest: '
  + (r.messages[0] ? `${r.messages[0].from} — ${r.messages[0].subject}` : 'none'));
