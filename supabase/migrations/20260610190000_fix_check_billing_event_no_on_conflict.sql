-- Replace ON CONFLICT-based upsert with an explicit existence check.
-- ON CONFLICT requires the inferred target to exactly match an existing
-- unique constraint/index (including any partial WHERE predicate), and that
-- has proven fragile as the underlying index on check_billing_events has
-- changed over time, causing:
-- "there is no unique or exclusion constraint matching the ON CONFLICT specification"

CREATE OR REPLACE FUNCTION public.record_check_billing_event()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_price integer;
  v_currency text;
  v_tenant_billing_enabled boolean;
  v_tenant_rate integer;
BEGIN
  IF NEW.status = 'deposited'
     AND (OLD.status IS DISTINCT FROM 'deposited')
     AND NEW.tenant_id IS NOT NULL THEN

    IF EXISTS (
      SELECT 1 FROM public.check_billing_events
      WHERE check_intake_item_id = NEW.id AND event_type = 'check_processing'
    ) THEN
      RETURN NEW;
    END IF;

    -- Check tenant-specific billing
    SELECT per_check_billing_enabled, per_check_rate_cents
      INTO v_tenant_billing_enabled, v_tenant_rate
    FROM public.tenants
    WHERE id = NEW.tenant_id;

    IF v_tenant_billing_enabled = true THEN
      v_price := v_tenant_rate;
      v_currency := 'usd';
    ELSE
      -- Fallback to global config
      SELECT price_per_check_cents, currency
        INTO v_price, v_currency
      FROM public.check_billing_config
      WHERE active = true
      ORDER BY created_at DESC
      LIMIT 1;

      IF v_price IS NULL THEN
        v_price := 300;
        v_currency := 'usd';
      END IF;
    END IF;

    INSERT INTO public.check_billing_events (
      tenant_id, check_intake_item_id, unit_price_cents, currency, status, event_type
    ) VALUES (
      NEW.tenant_id, NEW.id, v_price, v_currency, 'recorded', 'check_processing'
    );
  END IF;

  RETURN NEW;
END;
$function$;
