/* GoHighLevel, via Private Integration Tokens.

   Not OAuth. A PIT is a long-lived scoped token generated in a sub-account's own
   UI. It behaves like a fixed access token: nothing renews it, and it only
   changes when rotated by hand. One token per sub-account, so a three-location
   agency is three rows.

   The consequence worth stating: when a token is rotated or revoked in GHL,
   calls simply start failing and the only fix is pasting a new one. So the first
   401 sets status='reauth' and surfaces it rather than retrying forever. */

const BASE = 'https://services.leadconnectorhq.com';

/* The Version header is required. Omitting it produces failures that look like
   auth problems and are not. */
const headers = token => ({
  Authorization: `Bearer ${token}`,
  Version: '2021-07-28',
  Accept: 'application/json'
});

export class GhlError extends Error {
  constructor(message, { status, kind }){
    super(message);
    this.status = status;
    this.kind = kind;           // 'auth' | 'scope' | 'notfound' | 'rate' | 'other'
  }
}

function classify(status, body){
  const detail = body?.message || body?.error || '';
  if (status === 401) {
    return new GhlError('That token was rejected. Check it was copied whole, and that it has not been rotated in GHL.',
      { status, kind: 'auth' });
  }
  if (status === 403) {
    return new GhlError('The token is valid but missing scopes. It needs locations.readonly, contacts, opportunities and conversations.',
      { status, kind: 'scope' });
  }
  if (status === 404) {
    return new GhlError('No sub-account with that Location ID, or this token does not cover it.',
      { status, kind: 'notfound' });
  }
  if (status === 429) {
    return new GhlError('GHL is rate limiting this location. Try again in a few seconds.',
      { status, kind: 'rate' });
  }
  return new GhlError(`GHL ${status}${detail ? ': ' + detail : ''}`, { status, kind: 'other' });
}

/* Rate limits are per location: 100 requests per 10 seconds and 200k per day.
   The headers are read so a caller can back off before being throttled rather
   than after. */
const readLimits = res => ({
  remaining: Number(res.headers.get('X-RateLimit-Remaining')),
  max: Number(res.headers.get('X-RateLimit-Max')),
  dailyRemaining: Number(res.headers.get('X-RateLimit-Daily-Remaining'))
});

export async function call(token, path, { method = 'GET', body } = {}){
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...headers(token),
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const json = await res.json().catch(() => null);
  if (!res.ok) throw classify(res.status, json);
  return { data: json, limits: readLimits(res) };
}

/* Proves a token before a row is written. A 200 means it is valid *and* scoped to
   that location, which a token-shape check cannot tell you. */
export async function verifyLocation(token, locationId){
  const { data } = await call(token, `/locations/${encodeURIComponent(locationId)}`);
  const loc = data?.location || data;
  return {
    id: loc?.id || locationId,
    name: loc?.name || loc?.businessName || locationId
  };
}
