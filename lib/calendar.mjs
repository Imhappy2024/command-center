/* Calendar shaping, shared by every provider.

   Sources normalise their events to:
     { start, end, allDay, title, sub, account, source }
   where start/end are local wall-clock strings, "YYYY-MM-DDTHH:MM:SS", already
   in the target zone. Both Graph and Google can return times that way if asked
   (Prefer: outlook.timezone / timeZone=), which keeps this module free of any
   offset arithmetic. */

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export const dateKey = value => String(value).slice(0, 10);
export const hhmm = value => String(value).slice(11, 16);

/* Today according to the dashboard's zone, not the server's. */
export function todayKey(tz){
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/* Date-only arithmetic in UTC, so a DST boundary cannot shift the week. */
export function weekKeys(fromKey){
  const [y, m, d] = fromKey.split('-').map(Number);
  const cursor = new Date(Date.UTC(y, m - 1, d));
  cursor.setUTCDate(cursor.getUTCDate() - ((cursor.getUTCDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => {
    const day = new Date(cursor);
    day.setUTCDate(day.getUTCDate() + i);
    return { key: day.toISOString().slice(0, 10), day: DAY_NAMES[i], date: day.getUTCDate() };
  });
}

export function spanMinutes(start, end){
  return Math.round((new Date(end) - new Date(start)) / 60000);
}

export function humanDuration(mins){
  if (!mins || mins <= 0) return '';
  const h = Math.floor(mins / 60), m = mins % 60;
  if (!h) return `${m}m`;
  return m ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`;
}

/* Gaps no calendar covers. Busy in one account is busy overall — the only
   useful reading when the question is "when am I actually free". */
function gapsFor(events, dayKey, { from = '08:00:00', to = '18:00:00', minMinutes = 45 } = {}){
  const dayStart = new Date(`${dayKey}T${from}`);
  const dayEnd = new Date(`${dayKey}T${to}`);

  const busy = events
    .filter(e => !e.allDay && dateKey(e.start) === dayKey)
    .map(e => [new Date(e.start), new Date(e.end)])
    .sort((a, b) => a[0] - b[0]);

  const open = [];
  let cursor = dayStart;
  for (const [s, e] of busy) {
    if (s > cursor) open.push([cursor, s < dayEnd ? s : dayEnd]);
    if (e > cursor) cursor = e;
    if (cursor >= dayEnd) break;
  }
  if (cursor < dayEnd) open.push([cursor, dayEnd]);

  return open
    .map(([s, e]) => ({ s, e, mins: Math.round((e - s) / 60000) }))
    .filter(b => b.mins >= minMinutes);
}

const clock = d => String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');

export function buildCalendar(events, { tz, accounts = [], maxBlocks = 5 } = {}){
  const today = todayKey(tz);
  const week = weekKeys(today);
  const sorted = [...events].sort((a, b) => String(a.start).localeCompare(String(b.start)));
  const multi = accounts.filter(Boolean).length > 1;

  const weekDays = week.map(w => {
    const count = sorted.filter(e => dateKey(e.start) === w.key).length;
    return {
      day: w.day,
      date: w.date,
      count,
      label: count ? `${count} event${count === 1 ? '' : 's'}` : 'clear',
      today: w.key === today
    };
  });

  const todayEvents = sorted.filter(e => dateKey(e.start) === today);
  const bookedMins = todayEvents
    .filter(e => !e.allDay)
    .reduce((n, e) => n + Math.max(0, spanMinutes(e.start, e.end)), 0);

  const blocks = [];
  for (const w of week) {
    if (w.key < today || blocks.length >= maxBlocks) continue;
    const dayEvents = sorted.filter(e => dateKey(e.start) === w.key);
    for (const b of gapsFor(sorted, w.key)) {
      if (blocks.length >= maxBlocks) break;
      blocks.push({
        day: w.day,
        range: `${clock(b.s)} – ${clock(b.e)}`,
        note: dayEvents.length ? 'Between meetings' : 'Nothing booked all day',
        chip: { tone: b.mins >= 180 ? 'jade' : '', text: humanDuration(b.mins) }
      });
    }
  }

  return {
    timezone: tz,
    accounts,
    weekCount: sorted.length,
    bookedMins,
    week: weekDays,
    blocks,
    today: todayEvents.map(e => ({
      time: e.allDay ? 'All day' : hhmm(e.start),
      title: e.title || '(no subject)',
      sub: [e.sub, multi ? e.account : null].filter(Boolean).join(' · '),
      account: e.account,
      chip: e.allDay
        ? { text: 'All day' }
        : { text: humanDuration(spanMinutes(e.start, e.end)) }
    }))
  };
}

/* Query window covering the whole of the current week, as local wall clock. */
export function weekWindow(tz){
  const week = weekKeys(todayKey(tz));
  return { start: `${week[0].key}T00:00:00`, end: `${week[6].key}T23:59:59` };
}
