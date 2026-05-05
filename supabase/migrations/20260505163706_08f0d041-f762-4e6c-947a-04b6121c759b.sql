-- Remove blocking guards on legacy check status transitions.
-- The new stage model (check_stage) is the source of truth; the legacy
-- text status column should never raise exceptions on the user.
-- Per "warn-not-block" rule: drop the enforcement trigger entirely.

DROP TRIGGER IF EXISTS enforce_check_status_transition_trg ON public.check_intake_items;
DROP TRIGGER IF EXISTS trg_enforce_check_status_transition ON public.check_intake_items;
DROP TRIGGER IF EXISTS enforce_check_status_transition ON public.check_intake_items;

-- Find any remaining triggers using this function and drop them
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT tgname, c.relname
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE p.proname = 'enforce_check_status_transition'
      AND NOT t.tgisinternal
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', r.tgname, r.relname);
  END LOOP;
END $$;

-- Replace function body with a no-op so any orphan reference still works,
-- but only inserts an audit row and never blocks.
CREATE OR REPLACE FUNCTION public.enforce_check_status_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO public.check_status_audit(check_intake_item_id, from_status, to_status, changed_by, source)
    VALUES (NEW.id, OLD.status, NEW.status, auth.uid(), 'trigger');
  ELSIF TG_OP = 'INSERT' THEN
    INSERT INTO public.check_status_audit(check_intake_item_id, from_status, to_status, changed_by, source)
    VALUES (NEW.id, NULL, NEW.status, auth.uid(), 'trigger');
  END IF;
  RETURN NEW;
END;
$function$;