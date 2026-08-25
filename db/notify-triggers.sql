-- Live-update triggers on the portal's GHL tables.
--
-- This is the ONE sanctioned touch of tables command-center does not own, and it
-- exists because the owner asked for it explicitly: a new ghl_location row must
-- appear in the dashboard without a reload, and a lead or ghl_message change must
-- update only the row it concerns.
--
-- Deliberately NOT in schema.sql: that file creates command-center's own tables
-- and must never grow a portal-table statement by drift. This file is applied
-- separately, is additive only — a function and AFTER triggers, no column, no
-- constraint, no data — and failing to apply it degrades to "no live updates",
-- never to a boot failure.
--
-- Why LISTEN/NOTIFY rather than Supabase Realtime: command-center already holds
-- a session-pooler Postgres connection, and LISTEN works in session mode. Using
-- it means no Supabase JS client, no realtime publication config, and no second
-- credential to manage.

-- One function for every table. It reads the identifying columns out of
-- to_jsonb(NEW), so a table that lacks one simply contributes NULL — the same
-- function serves all five tables below. The payload is ids only, never row
-- data: NOTIFY caps payloads at 8000 bytes and a lead's custom_fields jsonb alone
-- could blow that. The browser fetches the row it is told about.
CREATE OR REPLACE FUNCTION public.cc_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  rec jsonb := to_jsonb(NEW);
BEGIN
  PERFORM pg_notify('cc_changes', json_build_object(
    'tbl', TG_TABLE_NAME,
    'op',  TG_OP,
    'location',     rec->>'ghl_location_id',
    'contact',      rec->>'ghl_contact_id',
    'conversation', rec->>'ghl_conversation_id'
  )::text);
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- Task 3: a new sub-account. INSERT only — the dashboard adds the new row and
-- leaves everything already loaded alone.
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS cc_notify_location ON public.ghl_location;
CREATE TRIGGER cc_notify_location
  AFTER INSERT ON public.ghl_location
  FOR EACH ROW EXECUTE FUNCTION public.cc_notify();

-- ---------------------------------------------------------------------------
-- Task 5: a lead changed. INSERT and UPDATE are separate triggers because only
-- an UPDATE trigger may carry a WHEN clause, and the clause matters: the ingest
-- pipeline re-upserts rows it has already seen, and a no-op UPDATE must not
-- make every open dashboard refetch a lead that did not change.
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS cc_notify_lead_ins ON public.lead;
CREATE TRIGGER cc_notify_lead_ins
  AFTER INSERT ON public.lead
  FOR EACH ROW EXECUTE FUNCTION public.cc_notify();

DROP TRIGGER IF EXISTS cc_notify_lead_upd ON public.lead;
CREATE TRIGGER cc_notify_lead_upd
  AFTER UPDATE ON public.lead
  FOR EACH ROW
  WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION public.cc_notify();

-- The lead ROW on screen shows stage and value, and those live on the
-- opportunity, not the lead. An opportunity move must refresh the lead card.
DROP TRIGGER IF EXISTS cc_notify_opportunity_ins ON public.ghl_opportunity;
CREATE TRIGGER cc_notify_opportunity_ins
  AFTER INSERT ON public.ghl_opportunity
  FOR EACH ROW EXECUTE FUNCTION public.cc_notify();

DROP TRIGGER IF EXISTS cc_notify_opportunity_upd ON public.ghl_opportunity;
CREATE TRIGGER cc_notify_opportunity_upd
  AFTER UPDATE ON public.ghl_opportunity
  FOR EACH ROW
  WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION public.cc_notify();

-- ---------------------------------------------------------------------------
-- Task 7: a message changed. The browser refetches that one contact's thread and
-- that one lead row (last activity, unread), nothing else.
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS cc_notify_message_ins ON public.ghl_message;
CREATE TRIGGER cc_notify_message_ins
  AFTER INSERT ON public.ghl_message
  FOR EACH ROW EXECUTE FUNCTION public.cc_notify();

DROP TRIGGER IF EXISTS cc_notify_message_upd ON public.ghl_message;
CREATE TRIGGER cc_notify_message_upd
  AFTER UPDATE ON public.ghl_message
  FOR EACH ROW
  WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION public.cc_notify();

-- Inbound webhooks with no ids land here and the thread shows them as pending
-- until reconciled. A new one is a new message in the conversation.
DROP TRIGGER IF EXISTS cc_notify_inbox_ins ON public.ghl_message_inbox;
CREATE TRIGGER cc_notify_inbox_ins
  AFTER INSERT ON public.ghl_message_inbox
  FOR EACH ROW EXECUTE FUNCTION public.cc_notify();
