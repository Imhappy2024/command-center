/* OAuth providers for the Connect buttons.

   Delegated authorisation-code flow: the signed-in human approves access to
   their own mailbox. No Workspace domain-wide delegation, no Entra admin
   consent for application permissions — which is the whole point of offering
   it alongside the environment-variable paths. */

const GOOGLE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.readonly'
];

const MS_SCOPES = [
  'openid',
  'email',
  'offline_access',
  'https://graph.microsoft.com/Mail.Read',
  'https://graph.microsoft.com/Calendars.Read',
  'https://graph.microsoft.com/Contacts.Read'
];

export const PROVIDERS = {
  google: {
    label: 'Google',
    detail: 'Gmail — unread counts and newest threads',
    feeds: ['Inbox'],
    clientId: env => env.GOOGLE_CLIENT_ID,
    clientSecret: env => env.GOOGLE_CLIENT_SECRET,
    setupHint: 'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET from a Google Cloud OAuth client of type "Web application".',
    tokenUrl: () => 'https://oauth2.googleapis.com/token',
    authorizeUrl(env, { redirect, state }){
      return 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
        client_id: this.clientId(env),
        redirect_uri: redirect,
        response_type: 'code',
        scope: GOOGLE_SCOPES.join(' '),
        access_type: 'offline',
        prompt: 'consent',          // force a refresh_token on repeat connects
        include_granted_scopes: 'true',
        state
      });
    },
    async identify(accessToken){
      const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      if (!r.ok) return null;
      const j = await r.json();
      return j.email || null;
    }
  },

  microsoft: {
    label: 'Microsoft',
    detail: 'Outlook mail, calendar and contacts',
    feeds: ['Inbox', 'Calendar'],
    clientId: env => env.MS_CLIENT_ID,
    clientSecret: env => env.MS_CLIENT_SECRET,
    setupHint: 'Set MS_CLIENT_ID and MS_CLIENT_SECRET, and add the redirect URI to the app registration under Authentication -> Web.',
    tokenUrl: env => `https://login.microsoftonline.com/${env.MS_TENANT_ID || 'common'}/oauth2/v2.0/token`,
    authorizeUrl(env, { redirect, state }){
      const tenant = env.MS_TENANT_ID || 'common';
      return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize?` + new URLSearchParams({
        client_id: this.clientId(env),
        response_type: 'code',
        redirect_uri: redirect,
        response_mode: 'query',
        scope: MS_SCOPES.join(' '),
        state
      });
    },
    async identify(accessToken){
      const r = await fetch('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName', {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      if (!r.ok) return null;
      const j = await r.json();
      return j.mail || j.userPrincipalName || null;
    }
  }
};

export const isConfigured = (name, env) => {
  const p = PROVIDERS[name];
  return Boolean(p && p.clientId(env) && p.clientSecret(env));
};

async function postForm(url, body){
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = json.error_description?.split(/[\r\n]/)[0] || json.error || res.statusText;
    throw new Error(`${res.status} ${detail}`);
  }
  return json;
}

export async function exchangeCode(name, env, { code, redirect }){
  const p = PROVIDERS[name];
  const tok = await postForm(p.tokenUrl(env), {
    code,
    client_id: p.clientId(env),
    client_secret: p.clientSecret(env),
    redirect_uri: redirect,
    grant_type: 'authorization_code'
  });
  if (!tok.refresh_token) {
    throw new Error(
      'the provider returned no refresh_token, so the connection would break within the hour. ' +
      (name === 'google'
        ? 'Revoke the app at myaccount.google.com/permissions and connect again.'
        : 'Confirm offline_access is among the granted scopes.')
    );
  }
  return {
    refresh_token: tok.refresh_token,
    access_token: tok.access_token,
    expires_at: Date.now() + (Number(tok.expires_in || 3600) - 60) * 1000,
    scope: tok.scope || null,
    account: await PROVIDERS[name].identify(tok.access_token).catch(() => null),
    connected_at: new Date().toISOString()
  };
}

async function refreshAccess(name, env, record){
  const p = PROVIDERS[name];
  const tok = await postForm(p.tokenUrl(env), {
    refresh_token: record.refresh_token,
    client_id: p.clientId(env),
    client_secret: p.clientSecret(env),
    grant_type: 'refresh_token'
  });
  return {
    ...record,
    access_token: tok.access_token,
    // Google omits refresh_token on refresh; Microsoft rotates it.
    refresh_token: tok.refresh_token || record.refresh_token,
    expires_at: Date.now() + (Number(tok.expires_in || 3600) - 60) * 1000
  };
}

/* Returns a usable access token for a connected provider, refreshing and
   re-persisting when the cached one has aged out. null when not connected. */
export async function accessTokenFor(name, env, store){
  if (!store?.enabled || !isConfigured(name, env)) return null;
  const record = await store.get(`oauth:${name}`);
  if (!record?.refresh_token) return null;

  if (record.access_token && record.expires_at > Date.now()) {
    return { token: record.access_token, account: record.account };
  }

  const fresh = await refreshAccess(name, env, record);
  await store.set(`oauth:${name}`, fresh);
  return { token: fresh.access_token, account: fresh.account };
}
