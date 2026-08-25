/* Provider configuration, code exchange and token refresh.

   Delegated authorization-code flow with PKCE: the signed-in human approves
   access to their own mailbox. No Workspace domain-wide delegation and no Entra
   admin consent for application permissions.

   Three provider properties exist because not every OAuth provider behaves like
   Google and Microsoft, and the original shape of this file quietly assumed they
   all did:

     refreshKind   How a credential is renewed. 'refresh_token' is the classic
                   flow. 'long_lived_exchange' has no refresh token at all — a
                   long-lived access token is swapped for a fresh one before it
                   expires. 'none' never expires and needs nothing.

     refresh()     An optional provider-supplied renewal. Meta's is a GET with
                   grant_type=fb_exchange_token, which cannot share the form-post
                   path below.

     discover()    An optional enumeration of the assets a grant covers. Every
                   provider here used to yield exactly one account row; one Meta
                   sign-in yields a row per Page, per linked Instagram account and
                   per ad account. */

import * as meta from '../providers/meta.js';
import * as x from '../providers/x.js';

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

/* Two scopes because they are two APIs: the Data API knows the channel's current
   totals, and only the Analytics API breaks anything down by day. */
const YOUTUBE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/yt-analytics.readonly'
];

/* Metrics and ads only. pages_messaging and instagram_manage_messages are
   Advanced Access, would fail review with no messaging feature to demonstrate,
   and requesting an unapproved permission degrades the whole grant. When DMs
   arrive they belong in the Inbox as accounts, not in the Social view. */
const META_VERSION = 'v23.0';
const META_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'instagram_basic',
  'instagram_manage_insights',
  'read_insights',
  'business_management',
  'ads_read'
];

/* offline.access is what yields a refresh token; without it the connection dies
   in two hours. tweet.read is needed for the post metrics, users.read for the
   follower count. */
const X_SCOPES = ['tweet.read', 'users.read', 'offline.access'];

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
    refreshKind: 'refresh_token',
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
    refreshKind: 'refresh_token',
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

  /* Its own provider key rather than a scope bolted onto `google`, because
     upsertOAuth keys on (provider, provider_uid): the same Google user connecting
     mail and then YouTube would collide on one row and the second connect would
     overwrite the first. Same client credentials, separate redirect URI. */
  youtube: {
    label: 'YouTube',
    blurb: 'Channel metrics and analytics',
    feeds: ['social'],
    oauth: true,
    refreshKind: 'refresh_token',
    vars: { id: 'GOOGLE_CLIENT_ID', secret: 'GOOGLE_CLIENT_SECRET' },
    setupHint: 'Reuses GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET. Add /oauth/callback/youtube to the same OAuth client\'s redirect URIs, and enable the YouTube Data and YouTube Analytics APIs.',
    tokenUrl: () => 'https://oauth2.googleapis.com/token',
    authorizeUrl(env, { redirect, state, challenge }){
      return 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
        client_id: env[this.vars.id],
        redirect_uri: redirect,
        response_type: 'code',
        scope: YOUTUBE_SCOPES.join(' '),
        access_type: 'offline',
        prompt: 'select_account consent',
        include_granted_scopes: 'true',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state
      });
    },
    async identify(accessToken){
      const r = await fetch(
        'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
        { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!r.ok) throw new Error(`YouTube channels failed: ${r.status}`);
      const j = await r.json();
      const c = j.items?.[0];
      /* A Google account with no channel is a real case and the message has to
         say so, or it reads as a scope problem. */
      if (!c?.id) throw new Error('this Google account has no YouTube channel');
      return { uid: c.id, email: c.snippet?.customUrl || c.snippet?.title || c.id };
    }
  },

  /* One sign-in covering Facebook Pages, Instagram and Ads. The grant row itself
     is what holds the renewable long-lived user token; the rows the Social view
     actually reads are produced by discover() and are the three derived providers
     below. */
  meta: {
    label: 'Meta',
    blurb: 'Facebook Pages, Instagram and Ads — one sign-in covers all three',
    feeds: ['social'],
    oauth: true,
    refreshKind: 'long_lived_exchange',
    vars: { id: 'META_APP_ID', secret: 'META_APP_SECRET' },
    setupHint: 'Set META_APP_ID and META_APP_SECRET from a Business-type app at developers.facebook.com, and add the redirect URI under Facebook Login, Settings, Valid OAuth Redirect URIs.',
    tokenUrl: () => `https://graph.facebook.com/${META_VERSION}/oauth/access_token`,
    authorizeUrl(env, { redirect, state, challenge }){
      return `https://www.facebook.com/${META_VERSION}/dialog/oauth?` + new URLSearchParams({
        client_id: env[this.vars.id],
        redirect_uri: redirect,
        response_type: 'code',
        scope: META_SCOPES.join(','),
        /* Without this Facebook silently re-grants exactly what was granted
           last time and returns straight away. It is what stopped a second ad
           account being added, and what made a Page left unticked the first
           time impossible to add afterwards: rerequest re-shows the dialog,
           asset picker included.

           It cannot force a DIFFERENT Facebook user — no parameter can. To add
           assets belonging to another login you have to sign out of Facebook
           first, or use another browser profile. */
        auth_type: 'rerequest',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state
      });
    },
    exchangeLongLived: meta.exchangeLongLived,
    refresh: meta.refresh,
    identify: meta.identify,
    discover: meta.discover
  },

  /* Derived from a Meta grant, never connected directly — hence `derived`, which
     keeps them out of the connect sheet while still letting feed filtering and
     refresh semantics resolve for their rows.

     Page tokens obtained from a long-lived user token do not expire, so these two
     are 'none' and refreshTokens() hands the stored value straight back. */
  facebook: {
    label: 'Facebook Page',
    feeds: ['social'],
    oauth: false,
    derived: true,
    refreshKind: 'none',
    setupHint: 'Connected by signing in with Meta.'
  },

  instagram: {
    label: 'Instagram',
    feeds: ['social'],
    oauth: false,
    derived: true,
    refreshKind: 'none',
    setupHint: 'Connected by signing in with Meta. The Instagram account must be a business account linked to a Page.'
  },

  /* Ad insights are read as the user rather than as a Page, so this row stores
     the long-lived user token and is renewed like the grant itself. */
  meta_ads: {
    label: 'Meta Ads',
    feeds: ['social'],
    oauth: false,
    derived: true,
    refreshKind: 'long_lived_exchange',
    refresh: meta.refresh,
    setupHint: 'Connected by signing in with Meta, if ads_read was granted. Business Verification must be complete before it returns data.'
  },

  /* PKCE here is mandatory rather than belt and braces, and the token endpoint
     wants HTTP Basic auth instead of credentials in the body — hence the
     provider-owned exchange and refresh. X rotates its refresh token on every
     renewal, like Microsoft, which the shared path already handles.

     Metered: no free tier since February 2026, $0.005 a read. providers/x.js
     caches for fifteen minutes and counts every call. */
  x: {
    label: 'X',
    blurb: 'Post and follower metrics — billed per read',
    feeds: ['social'],
    oauth: true,
    refreshKind: 'refresh_token',
    vars: { id: 'X_CLIENT_ID', secret: 'X_CLIENT_SECRET' },
    setupHint: 'Set X_CLIENT_ID and X_CLIENT_SECRET from an OAuth 2.0 "Web App" at developer.x.com. Reads are billed per call.',
    tokenUrl: () => 'https://api.twitter.com/2/oauth2/token',
    authorizeUrl(env, { redirect, state, challenge }){
      return 'https://twitter.com/i/oauth2/authorize?' + new URLSearchParams({
        client_id: env[this.vars.id],
        redirect_uri: redirect,
        response_type: 'code',
        scope: X_SCOPES.join(' '),
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state
      });
    },
    exchange: x.exchange,
    refresh: x.refresh,
    identify: x.identify
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

/* Defaults to the classic flow, so a provider that omits refreshKind behaves
   exactly as it did before this property existed. */
export const refreshKindOf = name => PROVIDERS[name]?.refreshKind || 'refresh_token';

export { postForm, expiryFrom };

export async function exchangeCode(name, env, { code, redirect, verifier }){
  const p = PROVIDERS[name];

  /* A provider-owned code exchange, for the ones that cannot use the form post.
     X wants HTTP Basic auth with the client id and secret rather than credentials
     in the body, and sending them in the body is simply rejected. */
  const tok = p.exchange
    ? await p.exchange(env, { code, redirect, verifier })
    : await postForm(p.tokenUrl(env), {
        code,
        client_id: env[p.vars.id],
        client_secret: env[p.vars.secret],
        redirect_uri: redirect,
        grant_type: 'authorization_code',
        code_verifier: verifier
      });

  /* Only fatal where a refresh token is how the connection survives. Meta never
     issues one — its durable credential is a long-lived access token obtained by
     a second exchange — so demanding one here is what would have thrown the
     moment a social provider was added. */
  if (refreshKindOf(name) === 'refresh_token' && !tok.refresh_token) {
    throw new Error(
      'the provider returned no refresh token, so the connection would break within the hour. ' +
      (name === 'google' || name === 'youtube'
        ? 'This usually means the app is already authorised — revoke it at myaccount.google.com/permissions and connect again.'
        : 'Confirm offline_access is among the granted scopes.')
    );
  }

  /* The hook that turns a short-lived grant into a durable one. Whatever it
     returns is what gets stored, so a provider owns its own credential shape. */
  if (p.exchangeLongLived) {
    const long = await p.exchangeLongLived(env, tok);
    const who = await p.identify(long.accessToken);
    return {
      uid: who.uid,
      email: who.email,
      /* The long-lived token goes in the refresh_token column. It is the durable
         credential, exactly as the IMAP app password already stored there is. */
      refreshToken: long.accessToken,
      accessToken: long.accessToken,
      expiresAt: long.expiresAt,
      scope: tok.scope || null,
      grantedScopes: long.grantedScopes || null
    };
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

  /* Nothing to renew. A Facebook Page token derived from a long-lived user token
     does not expire, so the stored credential is returned as-is rather than being
     put through an exchange that would fail. */
  if (refreshKindOf(name) === 'none') {
    return { accessToken: refreshToken, refreshToken, expiresAt: null, scope: null };
  }

  /* A provider-owned renewal. Meta's is a GET with grant_type=fb_exchange_token
     and cannot share the form post below. */
  if (p.refresh) return p.refresh(env, refreshToken);

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
