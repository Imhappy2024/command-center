-- Live-update triggers on the portal's GHL tables.
--
-- This is the ONE sanctioned touch of tables command-center does not own, and it
-- exists because the owner asked for it explicitly: a new ghl_location row must
-- appear in the dashboard without a reload (and, in later steps, lead and
-- ghl_message changes must update only the row they concern).
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
-- function serves ghl_location now and lead / ghl_message in later steps.
-- The payload is ids only, never row data: NOTIFY caps payloads at 8000 bytes
-- and a lead's custom_fields jsonb alone could blow that.
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

-- Task 3: a new sub-account. INSERT only — the dashboard adds the new row and
-- leaves everything already loaded alone, so an UPDATE here has no consumer yet.
DROP TRIGGER IF EXISTS cc_notify_location ON public.ghl_location;
CREATE TRIGGER cc_notify_location
  AFTER INSERT ON public.ghl_location
  FOR EACH ROW EXECUTE FUNCTION public.cc_notify();
