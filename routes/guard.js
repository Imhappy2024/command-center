/* Postgres restarts are routine on Railway, and a rejected query inside an async
   Express handler is an unhandled rejection — which takes the whole container
   down instead of failing the one request that hit it. Every handler that reads
   the account table goes through here. */

export const guarded = (label, handler) => async (req, res) => {
  try {
    await handler(req, res);
  } catch (err) {
    console.error(`[${label}]`, err.message);
    /* The reason rides along. Every guarded route sits behind auth, and "account
       store unavailable" with the cause only in the server log turned a wrong
       DATABASE_URL into a sidebar that read as an empty database. */
    if (!res.headersSent) {
      res.status(503).json({ error: 'database query failed', detail: err.message });
    }
  }
};
