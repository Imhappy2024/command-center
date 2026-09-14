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
    'conversation', rec->>'ghl_conversation_id',
    -- The social half. A GHL row has none of these and sends NULL, exactly as
    -- it already does for the two ids it lacks.
    'platform',     rec->>'platform',
    'account',      rec->>'account_id',
    'thread',       rec->>'thread_id'
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

-- ---------------------------------------------------------------------------
-- The social inbox: a comment, a message or a post arriving.
--
-- These ARE command-center's own tables, unlike everything above, and they are
-- here rather than in schema.sql because the mechanism is the same one: this
-- file is the live-update file, it is applied separately, and failing to apply
-- it degrades to "no live updates" rather than to a boot failure. Putting them
-- in schema.sql would tie a notification concern to table creation.
--
-- Wrapped in a guard because this file is applied as one statement batch. A
-- deployment whose schema has not caught up would otherwise fail the WHOLE
-- file and take the GHL triggers above down with it, which is a much worse
-- outcome than a quiet pass.
DO $social$
BEGIN
  IF to_regclass('public.social_items') IS NULL THEN
    RAISE NOTICE 'social tables are not present yet — skipping their live triggers';
    RETURN;
  END IF;

  -- A new comment or message. INSERT is the one that matters: it is the event
  -- the reader is waiting for.
  DROP TRIGGER IF EXISTS cc_notify_social_item_ins ON public.social_items;
  CREATE TRIGGER cc_notify_social_item_ins
    AFTER INSERT ON public.social_items
    FOR EACH ROW EXECUTE FUNCTION public.cc_notify();

  -- An UPDATE only when the CONTENT moved. Every sync re-upserts every row it
  -- fetched and bumps synced_at, so OLD.* IS DISTINCT FROM NEW.* is true on
  -- every row of every pass -- which would turn one fifteen-minute poll into a
  -- few hundred notifications that say nothing happened. The columns named here
  -- are the ones a person would see change.
  DROP TRIGGER IF EXISTS cc_notify_social_item_upd ON public.social_items;
  CREATE TRIGGER cc_notify_social_item_upd
    AFTER UPDATE ON public.social_items
    FOR EACH ROW
    WHEN (OLD.body        IS DISTINCT FROM NEW.body
       OR OLD.attachments IS DISTINCT FROM NEW.attachments
       OR OLD.reactions   IS DISTINCT FROM NEW.reactions
       OR OLD.likes       IS DISTINCT FROM NEW.likes
       OR OLD.pending     IS DISTINCT FROM NEW.pending)
    EXECUTE FUNCTION public.cc_notify();

  -- A new conversation or comment thread.
  DROP TRIGGER IF EXISTS cc_notify_social_thread_ins ON public.social_threads;
  CREATE TRIGGER cc_notify_social_thread_ins
    AFTER INSERT ON public.social_threads
    FOR EACH ROW EXECUTE FUNCTION public.cc_notify();

  -- And the fields the list itself draws from: when it was last spoken in,
  -- whether it is unread, who it is with, how many items it holds.
  DROP TRIGGER IF EXISTS cc_notify_social_thread_upd ON public.social_threads;
  CREATE TRIGGER cc_notify_social_thread_upd
    AFTER UPDATE ON public.social_threads
    FOR EACH ROW
    WHEN (OLD.last_at     IS DISTINCT FROM NEW.last_at
       OR OLD.unread      IS DISTINCT FROM NEW.unread
       OR OLD.item_count  IS DISTINCT FROM NEW.item_count
       OR OLD.last_snippet IS DISTINCT FROM NEW.last_snippet
       OR OLD.with_name   IS DISTINCT FROM NEW.with_name
       OR OLD.with_avatar IS DISTINCT FROM NEW.with_avatar
       OR OLD.tags        IS DISTINCT FROM NEW.tags)
    EXECUTE FUNCTION public.cc_notify();

  IF to_regclass('public.social_posts') IS NOT NULL THEN
    -- A new post. INSERT only, deliberately: the metrics poller updates reach
    -- and views on every existing post every pass, and a changed view count is
    -- not "a new post appeared" -- which is the thing being asked for here.
    DROP TRIGGER IF EXISTS cc_notify_social_post_ins ON public.social_posts;
    CREATE TRIGGER cc_notify_social_post_ins
      AFTER INSERT ON public.social_posts
      FOR EACH ROW EXECUTE FUNCTION public.cc_notify();
  END IF;
END $social$;
