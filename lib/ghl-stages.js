/* GHL stage name -> the six stages the Leads view renders.

   GHL stage names are user-defined per pipeline, so they will not match the
   UI's six and there is no id-based mapping to lean on. This file is the whole
   translation: when a pipeline gets renamed in GHL, this is the one place to
   edit.

   Two rules that matter more than the table:

   - `status` overrides the name. A GHL opportunity marked won or lost is won or
     lost whatever its stage is called, because a workflow can close a deal
     without moving it.
   - An unmatched name falls back to 'contacted', never to nothing. Dropping the
     lead would hide a real opportunity behind a naming mismatch, and 'contacted'
     is the one stage that claims least. */

export const UI_STAGES = ['new', 'contacted', 'qualified', 'proposal', 'won', 'lost'];

export const FALLBACK_STAGE = 'contacted';

/* Matched in order, and the order is load-bearing: 'unqualified' has to be
   tested before 'qualified' or it maps to the wrong end of the pipeline. The
   same goes for 'closed lost' against 'closed'. */
const PATTERNS = [
  ['lost',      ['unqualified', 'disqualified', 'closed lost', 'closed-lost', 'lost',
                 'dead', 'not interested', 'no show', 'abandoned', 'cancelled', 'canceled',
                 'declined', 'rejected', 'churn']],
  ['won',       ['closed won', 'closed-won', 'won', 'client', 'customer', 'funded',
                 'sold', 'signed', 'closed sale', 'paid']],
  ['proposal',  ['proposal', 'quote', 'quoted', 'offer', 'application', 'contract sent',
                 'contract', 'negotiat', 'pre-approval', 'preapproval', 'underwriting',
                 'estimate', 'pending']],
  ['qualified', ['qualified', 'appointment', 'booked', 'consult', 'discovery', 'demo',
                 'meeting', 'scheduled', 'showing', 'tour']],
  ['contacted', ['contacted', 'attempted', 'follow up', 'follow-up', 'followup',
                 'nurture', 'nurturing', 'in progress', 'working', 'engaged',
                 'reached', 'no answer', 'call back', 'callback']],
  ['new',       ['new', 'lead in', 'lead-in', 'incoming', 'inbound', 'unassigned',
                 'untouched', 'fresh', 'inquiry', 'enquiry', 'raw']]
];

/* Exact names win outright, so a stage literally called "New" cannot be dragged
   into 'lost' by a substring rule. */
const EXACT = new Map(UI_STAGES.map(s => [s, s]));

const norm = v => String(v || '').trim().toLowerCase();

/* status: GHL's own open|won|lost|abandoned. stageName: the pipeline stage. */
export function toUiStage(stageName, status){
  const st = norm(status);
  if (st === 'won') return 'won';
  if (st === 'lost' || st === 'abandoned') return 'lost';

  const name = norm(stageName);
  if (!name) return FALLBACK_STAGE;

  const exact = EXACT.get(name);
  if (exact) return exact;

  for (const [ui, needles] of PATTERNS) {
    if (needles.some(n => name.includes(n))) return ui;
  }
  return FALLBACK_STAGE;
}

/* The reverse direction, for writes: given a UI stage and the pipeline's own
   stage list, pick the GHL stage to move the opportunity into.

   There is no exact inverse — several GHL stages can map to one UI stage — so
   this takes the lowest-position stage that maps back to the requested one,
   which is the earliest point in the pipeline that satisfies the request.
   Returns null when the pipeline has no stage for it, and the caller reports
   that rather than guessing. */
export function toGhlStage(uiStage, stages, status){
  const want = norm(uiStage);
  const candidates = (stages || [])
    .filter(s => toUiStage(s.name, status) === want)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  return candidates[0] || null;
}

/* won and lost are status changes in GHL, not just stage moves. Writing the
   stage alone would leave the opportunity open in every GHL report. */
export const statusForUiStage = uiStage =>
  uiStage === 'won' ? 'won' : uiStage === 'lost' ? 'lost' : 'open';
