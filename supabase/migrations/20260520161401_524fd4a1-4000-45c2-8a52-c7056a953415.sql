
-- 1. Enable pg_net for async HTTP from triggers
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- 2. Add Freedom status mirror columns
ALTER TABLE public.check_intake_items
  ADD COLUMN IF NOT EXISTS partner_status TEXT,
  ADD COLUMN IF NOT EXISTS partner_status_label TEXT,
  ADD COLUMN IF NOT EXISTS partner_status_updated_at TIMESTAMPTZ;

-- 3. Trigger function: when a mirrored Freedom check's status changes,
--    fire-and-forget POST to our push-status-to-freedom edge function.
CREATE OR REPLACE FUNCTION public.notify_freedom_status_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_source_app TEXT;
  v_source_check_id TEXT;
  v_url TEXT;
  v_supabase_url TEXT;
BEGIN
  -- Only mirrored Freedom checks have external_origin set
  v_source_app := NEW.external_origin->>'source_app';
  v_source_check_id := NEW.external_origin->>'source_check_id';

  IF v_source_app IS DISTINCT FROM 'freedom_crm' OR v_source_check_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Only push when a status-bearing field actually changed
  IF NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.check_stage IS NOT DISTINCT FROM OLD.check_stage
     AND NEW.deposit_recommendation IS NOT DISTINCT FROM OLD.deposit_recommendation
  THEN
    RETURN NEW;
  END IF;

  -- Our own project URL (hardcoded to this ChecksOps project)
  v_url := 'https://nbcqwpysqgyxrrbgtmkw.supabase.co/functions/v1/push-status-to-freedom';

  PERFORM net.http_post(
    url := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := jsonb_build_object(
      'source_check_id', v_source_check_id,
      'status', NEW.status,
      'check_stage', NEW.check_stage,
      'deposit_recommendation', NEW.deposit_recommendation,
      'check_number', NEW.check_number,
      'carrier_name', NEW.carrier_name,
      'amount', NEW.amount
    )
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never block the row update if outbound push fails
  RAISE WARNING 'notify_freedom_status_change failed: %', SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_freedom_status_change ON public.check_intake_items;
CREATE TRIGGER trg_notify_freedom_status_change
AFTER UPDATE ON public.check_intake_items
FOR EACH ROW
EXECUTE FUNCTION public.notify_freedom_status_change();
