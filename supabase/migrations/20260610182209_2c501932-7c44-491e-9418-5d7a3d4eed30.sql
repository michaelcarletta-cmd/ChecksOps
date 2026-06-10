DROP INDEX IF EXISTS public.idx_unique_processing_event;

ALTER TABLE public.check_billing_events
ADD CONSTRAINT check_billing_events_check_event_unique
UNIQUE (check_intake_item_id, event_type);

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

    SELECT per_check_billing_enabled, per_check_rate_cents
      INTO v_tenant_billing_enabled, v_tenant_rate
    FROM public.tenants
    WHERE id = NEW.tenant_id;

    IF v_tenant_billing_enabled = true THEN
      v_price := v_tenant_rate;
      v_currency := 'usd';
    ELSE
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
    )
    ON CONFLICT ON CONSTRAINT check_billing_events_check_event_unique DO NOTHING;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.backfill_check_billing_events()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_inserted integer := 0;
  v_price integer;
  v_currency text;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin'::app_role) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT price_per_check_cents, currency INTO v_price, v_currency
  FROM public.check_billing_config WHERE active = true ORDER BY created_at DESC LIMIT 1;

  WITH ins AS (
    INSERT INTO public.check_billing_events (
      tenant_id,
      check_intake_item_id,
      unit_price_cents,
      currency,
      status,
      event_type
    )
    SELECT cii.tenant_id, cii.id, v_price, v_currency, 'recorded', 'check_processing'
    FROM public.check_intake_items cii
    WHERE cii.status = 'deposited'
      AND cii.tenant_id IS NOT NULL
    ON CONFLICT ON CONSTRAINT check_billing_events_check_event_unique DO NOTHING
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_inserted FROM ins;

  RETURN jsonb_build_object('inserted', v_inserted);
END;
$function$;