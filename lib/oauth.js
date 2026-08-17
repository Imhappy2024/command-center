/* Provider configuration, code exchange and token refresh.

   Delegated authorization-code flow with PKCE: the signed-in human approves
   access to their own mailbox. No Workspace domain-wide delegation and no Entra
   admin consent for application permissions. */

/* One grant covers both feeds. Google's returns Gmail and Google Calendar;
   Microsoft's returns Graph Mail and Graph Calendars. There is deliberately no
   second "connect calendar" flow and no separate calendar record — the account
   row is the only thing to create, and the only thing to reconnect.

   gmail.modify is the smallest scope that covers read, labels, archive, trash,
   drafts and send. It cannot permanently delete: users.messages.delete requires
   the full https://mail.google.com/ scope, which is a far broader ask, so
   permanent delete is simply not offered on Google accounts.

   'profile' is not requested. The callback needs the sub claim and the address,
   and 'openid email' already carries both. */
const GOOGLE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar.readonly'
];

const MS_SCOPES = [
  'openid',
  'email',
  'offline_access',
  'https://graph.microsoft.com/Mail.ReadWrite',
  'https://graph.microsoft.com/Mail.Send',
  'https://graph.microsoft.com/Calendars.Read'
];

/* Each OAuth provider names the variables it needs exactly once, in `vars`.
   Everything else — the credentials sent to the token endpoint, whether the
   provider counts as configured, and what the boot log reports — derives from
   that one list. Previously the boot log tested GOOGLE_CLIENT_ID directly while
   isConfigured() required the secret as well, so with only the ID set the log
   said "configured" and the connect sheet greyed the provider out. */
export const PROVIDERS = {
  google: {
    label: 'Google',
    feeds: ['mail', 'calendar'],
    oauth: true,
    vars: { id: 'GOOGLE_CLIENT_ID', secret: 'GOOGLE_CLIENT_SECRET' },
    setupHint: 'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET from a Google Cloud OAuth client of type "Web application".',
    tokenUrl: () => 'https://oauth2.googleapis.com/token',
    authorizeUrl(env, { redirect, state, challenge }){
      return 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
        client_id: env[this.vars.id],
        redirect_uri: redirect,
        response_type: 'code',
        scope: GOOGLE_SCOPES.join(' '),
        // Without offline there is no refresh token and the connection dies
        // inside the hour.
        access_type: 'offline',
        // select_account is what makes "add another mailbox" possible. Without
        // it Google silently reuses the browser's existing session, returns the
        // same address, and the upsert overwrites the account already stored —
        // with no error anywhere. consent is what guarantees a refresh_token
        // comes back on a reconnect.
        prompt: 'select_account consent',
        include_granted_scopes: 'true',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state
      });
    },
    async identify(accessToken){
      const r = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      if (!r.ok) throw new Error(`Google userinfo failed: ${r.status}`);
      const j = await r.json();
      if (!j.sub) throw new Error('Google userinfo returned no sub claim');
      return { uid: j.sub, email: j.email || '' };
    }
  },

  microsoft: {
    label: 'Microsoft',
    feeds: ['mail', 'calendar'],
    oauth: true,
    vars: { id: 'MS_CLIENT_ID', secret: 'MS_CLIENT_SECRET' },
    setupHint: 'Set MS_CLIENT_ID and MS_CLIENT_SECRET, and add the redirect URI to the app registration under Authentication -> Web.',
    tokenUrl: env => `https://login.microsoftonline.com/${env.MS_TENANT_ID || 'common'}/oauth2/v2.0/token`,
    authorizeUrl(env, { redirect, state, challenge }){
      const tenant = env.MS_TENANT_ID || 'common';
      return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize?` + new URLSearchParams({
        client_id: env[this.vars.id],
        response_type: 'code',
        redirect_uri: redirect,
        response_mode: 'query',
        scope: MS_SCOPES.join(' '),
        // Same reason as Google: without it, tenant SSO signs you straight back
        // in as the current user and a second mailbox can never be added.
        prompt: 'select_account',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state
      });
    },
    async identify(accessToken){
      const r = await fetch('https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName', {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      if (!r.ok) throw new Error(`Microsoft /me failed: ${r.status}`);
      const j = await r.json();
      if (!j.id) throw new Error('Microsoft /me returned no id');
      return { uid: j.id, email: j.mail || j.userPrincipalName || '' };
    }
  },

  /* No authorize URL and no token endpoint. Connected by form POST instead, so
     it carries no oauth config — but it still produces an accounts row, and the
     mail routes treat it like any other. */
  imap: {
    label: 'IMAP',
    feeds: ['mail'],
    oauth: false,
    setupHint: 'Enter the host, port and an app password for the mailbox.'
  },

  /* GoHighLevel, via a Private Integration Token rather than OAuth. The token is
     long-lived and only changes when rotated by hand, so there is no refresh
     path — on the first 401 the row goes to status='reauth' and the UI asks for
     a new one. Feeds leads only, so it never appears as a mailbox or calendar. */
  ghl: {
    label: 'GoHighLevel',
    feeds: ['leads'],
    oauth: false,
    setupHint: 'Create a Private Integration Token in the sub-account under Settings, Integrations.'
  }
};

/* Which of a provider's required variables are absent. Empty means configured.
   The single source of truth for both the boot log and the connect sheet. */
export function missingVars(name, env){
  const p = PROVIDERS[name];
  if (!p?.oauth) return [];            // nothing to configure server-side
  return Object.values(p.vars).filter(v => !env[v]);
}

export const isConfigured = (name, env) =>
  Boolean(PROVIDERS[name]) && missingVars(name, env).length === 0;

/* Errors surface the provider's own description because it is nearly always the
   actionable part (redirect_uri_mismatch, invalid_client, and so on). The
   response body is never logged: on a successful exchange it contains tokens. */
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

const expiryFrom = tok => Date.now() + (Number(tok.expires_in || 3600) - 60) * 1000;

export async function exchangeCode(name, env, { code, redirect, verifier }){
  const p = PROVIDERS[name];
  const tok = await postForm(p.tokenUrl(env), {
    code,
    client_id: env[p.vars.id],
    client_secret: env[p.vars.secret],
    redirect_uri: redirect,
    grant_type: 'authorization_code',
    code_verifier: verifier
  });

  if (!tok.refresh_token) {
    throw new Error(
      'the provider returned no refresh token, so the connection would break within the hour. ' +
      (name === 'google'
        ? 'This usually means the app is already authorised — revoke it at myaccount.google.com/permissions and connect again.'
        : 'Confirm offline_access is among the granted scopes.')
    );
  }

  const who = await p.identify(tok.access_token);
  return {
    uid: who.uid,
    email: who.email,
    refreshToken: tok.refresh_token,
    accessToken: tok.access_token,
    expiresAt: expiryFrom(tok),
    scope: tok.scope || null
  };
}

export async function refreshTokens(name, env, refreshToken){
  const p = PROVIDERS[name];
  const tok = await postForm(p.tokenUrl(env), {
    refresh_token: refreshToken,
    client_id: env[p.vars.id],
    client_secret: env[p.vars.secret],
    grant_type: 'refresh_token'
  });
  return {
    accessToken: tok.access_token,
    /* Microsoft rotates the refresh token on every renewal and invalidates the
       previous one, so the new value must be persisted or the next refresh
       fails. Google usually omits it, and dropping the stored one there would
       break the account just as thoroughly. Both cases, one line. */
    refreshToken: tok.refresh_token || refreshToken,
    expiresAt: expiryFrom(tok),
    scope: tok.scope || null
  };
}
