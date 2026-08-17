/* Shared shaping, so every provider hands the frontend identical objects.

   The frontend's render functions are the specification here. If something
   renders wrong, the fix belongs in a provider, not in a render function. */

const TZ = process.env.AGENT_TIMEZONE || undefined;

const dayKey = d => new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
}).format(d);

const clock = d => new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false
}).format(d);

const monthDay = d => new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, month: 'short', day: 'numeric'
}).format(d);

/* Preformatted for display, because the list shows a single short column and
   the rule for what belongs in it is presentation, not data: today is a clock,
   yesterday is a word, anything older is a date. */
export function displayTime(epochMs, now = Date.now()){
  if (!epochMs) return '';
  const d = new Date(epochMs);
  if (Number.isNaN(d.getTime())) return '';

  const today = dayKey(new Date(now));
  const then = dayKey(d);
  if (then === today) return clock(d);

  const yesterday = dayKey(new Date(now - 86_400_000));
  if (then === yesterday) return 'Yesterday';

  return monthDay(d);
}

/* "Jane Doe <jane@example.com>" -> { from: 'Jane Doe', addr: 'jane@example.com' }
   The list shows the display name and derives initials from it, so a bare
   address has to fall back to itself rather than to an empty avatar. */
export function parseAddress(raw){
  const s = String(raw || '').trim();
  const m = s.match(/^(.*?)\s*<([^>]+)>$/);
  if (m) {
    const name = m[1].replace(/^["']|["']$/g, '').trim();
    const addr = m[2].trim();
    return { from: name || addr, addr };
  }
  return { from: s || 'Unknown sender', addr: s };
}

/* Collapses a body to one line of preview text. Providers that give a usable
   snippet should pass it straight through instead of calling this. */
export const toSnippet = (text, len = 160) =>
  String(text || '').replace(/\s+/g, ' ').trim().slice(0, len);

export function message({ id, acct, folder, from, addr, subject, snippet, body, sortKey, unread, star }){
  return {
    id: String(id),
    acct,
    folder,
    from: from || 'Unknown sender',
    addr: addr || '',
    subject: subject || '(no subject)',
    snippet: snippet || '',
    body: body ?? null,          // filled in by the single-message fetch on open
    time: displayTime(sortKey),
    sortKey: sortKey || 0,
    unread: Boolean(unread),
    star: Boolean(star),
    /* No provider has a "flagged for reply" concept, and star is already mapped
       to Gmail's STARRED and Graph's flag. Always false rather than invented. */
    reply: false
  };
}

export function event({ id, cal, title, location, attendees, start, end, allDay }){
  return {
    id: String(id),
    cal,
    title: title || '(no title)',
    location: location || '',
    attendees: attendees || [],
    start,                        // ISO 8601; the loader parses to Date on arrival
    end,
    allDay: Boolean(allDay)
  };
}
