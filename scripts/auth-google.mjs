/* One-time helper: mints a Gmail refresh token.
   Run locally (never on Railway):  npm run auth:google

   Prereqs — Google Cloud Console:
     1. Create/pick a project, enable the Gmail API.
     2. APIs & Services -> Credentials -> Create OAuth client ID -> Desktop app.
     3. OAuth consent screen -> add your own address under Test users.
     4. Export the client id and secret before running:
          $env:GOOGLE_CLIENT_ID='...'; $env:GOOGLE_CLIENT_SECRET='...'
*/

import http from 'node:http';
import { randomBytes } from 'node:crypto';

const PORT = 5589;
const REDIRECT = `http://localhost:${PORT}/callback`;
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

const id = process.env.GOOGLE_CLIENT_ID;
const secret = process.env.GOOGLE_CLIENT_SECRET;

if (!id || !secret) {
  console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first.');
  process.exit(1);
}

const state = randomBytes(16).toString('hex');
const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
  client_id: id,
  redirect_uri: REDIRECT,
  response_type: 'code',
  scope: SCOPE,
  access_type: 'offline',
  prompt: 'consent',
  state
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }

  const finish = (code, msg) => { res.writeHead(code, { 'Content-Type': 'text/plain' }).end(msg); };

  if (url.searchParams.get('state') !== state) { finish(400, 'State mismatch.'); return; }
  const code = url.searchParams.get('code');
  if (!code) { finish(400, `No code. ${url.searchParams.get('error') || ''}`); return; }

  try {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: id, client_secret: secret,
        redirect_uri: REDIRECT, grant_type: 'authorization_code'
      })
    });
    const json = await r.json();
    if (!json.refresh_token) throw new Error(JSON.stringify(json));

    finish(200, 'Refresh token issued. Back to the terminal.');
    console.log('\nGOOGLE_REFRESH_TOKEN=' + json.refresh_token + '\n');
    console.log('Add that to Railway alongside GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.');
  } catch (err) {
    finish(500, 'Exchange failed: ' + err.message);
    console.error(err.message);
  }
  server.close();
});

server.listen(PORT, () => {
  console.log('Open this URL, approve, and the token prints here:\n');
  console.log(authUrl + '\n');
});
