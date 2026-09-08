/* How busy is this process, right now.

   Exists for one caller: the auto-updater needs to know when it is safe to
   exit. Restarting is only invisible if nothing is mid-flight -- a Claude turn
   streaming down an SSE connection, an upload, a three-minute ClickUp walk
   answering a request. Killing the process during any of those loses work the
   user asked for and did not get.

   Deliberately a counter and a timestamp rather than anything cleverer. The
   question is "is now a bad moment", and the honest answer to that is "is
   anything open". */

let open = 0;              // requests currently being served
let lastEmptyAt = Date.now();
const started = new Map(); // request -> when it began, for the stuck-stream case

/* Ten minutes. A request open longer than that is an SSE stream nobody is
   reading any more, or a socket the client abandoned without FIN -- either way
   it must not block updates forever, which is what a plain counter would do. */
const ABANDONED_MS = 10 * 60_000;

export function inflight(req, res, next){
  const id = Symbol('req');
  open++;
  started.set(id, Date.now());
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    open = Math.max(0, open - 1);
    started.delete(id);
    if (!open) lastEmptyAt = Date.now();
  };
  /* Both, because 'close' fires without 'finish' when the client goes away
     mid-response and 'finish' fires without 'close' on a keep-alive socket. */
  res.on('finish', finish);
  res.on('close', finish);
  next();
}

/* Requests that are genuinely still being worked on. */
export function liveCount(){
  const cut = Date.now() - ABANDONED_MS;
  let n = 0;
  for (const at of started.values()) if (at > cut) n++;
  return n;
}

/* Idle for at least `ms`, counting an abandoned stream as not-busy.

   lastEmptyAt only moves when the counter reaches zero, so a steady trickle of
   short polls -- which this dashboard does have -- never looks idle by that
   measure alone. Hence both tests: nothing live, and nothing live for a while. */
export function idleFor(ms){
  if (liveCount() > 0) return false;
  return Date.now() - lastEmptyAt >= ms;
}

export function busyReport(){
  const cut = Date.now() - ABANDONED_MS;
  const ages = [...started.values()].filter(at => at > cut).map(at => Date.now() - at);
  return {
    open: ages.length,
    stale: started.size - ages.length,
    oldestMs: ages.length ? Math.max(...ages) : 0,
    idleMs: ages.length ? 0 : Date.now() - lastEmptyAt
  };
}
