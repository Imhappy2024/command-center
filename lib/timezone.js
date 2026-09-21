/* The one zone this dashboard thinks in.

   Three modules used to read process.env.AGENT_TIMEZONE for themselves and each
   fell back to `undefined`, which means "whatever zone this process happens to
   be running in". On Railway that is UTC, so with the variable unset a lead
   that arrived at 4pm Central was shown as 9pm, and the header clock — which
   read the BROWSER's zone rather than either — could disagree with both.

   So: one place, and a real default rather than undefined. Central, because
   that is where the business is; AGENT_TIMEZONE still overrides it.

   Read at import time, like the values it replaces. That is fine for a hosted
   deployment, where the platform injects variables before the process starts.
   On a local run .env is loaded in server.js's body, which is AFTER this
   module has been evaluated — so a local AGENT_TIMEZONE is ignored and the
   default applies. That is worth knowing and not worth a lazy getter on every
   timestamp the app formats: the default is the value that machine would want
   anyway. */

export const DEFAULT_TZ = 'America/Chicago';

export const TZ = String(process.env.AGENT_TIMEZONE || '').trim() || DEFAULT_TZ;

/* Proved usable once, here, rather than throwing from inside a formatter
   halfway down a list of leads. An unusable zone falls back to the default and
   says so, because a silently wrong clock is the failure this file exists to
   prevent. */
export const SAFE_TZ = (() => {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: TZ });
    return TZ;
  } catch {
    console.error(`[tz] AGENT_TIMEZONE="${TZ}" is not a usable IANA zone; `
      + `using ${DEFAULT_TZ}.`);
    return DEFAULT_TZ;
  }
})();
