CREATE OR REPLACE FUNCTION public.tg_mirror_payee_to_endorsement()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  v_tenant uuid;
  v_type text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.check_endorsements
    WHERE check_id = OLD.check_id
      AND (payee_id = OLD.id
           OR (payee_id IS NULL AND lower(trim(payee_name)) = lower(trim(OLD.payee_name))))
      AND status NOT IN ('signed','waived');
    RETURN OLD;
  END IF;

  v_tenant := NEW.tenant_id;
  IF v_tenant IS NULL THEN
    SELECT tenant_id INTO v_tenant FROM public.check_intake_items WHERE id = NEW.check_id;
  END IF;

  v_type := public.normalize_endorsement_payee_type(NEW.payee_type);

  -- When a payee is renamed, drop the stale unsigned endorsement row that was
  -- keyed to the previous name so the rename edits (rather than duplicates).
  IF TG_OP = 'UPDATE' AND lower(trim(NEW.payee_name)) IS DISTINCT FROM lower(trim(OLD.payee_name)) THEN
    DELETE FROM public.check_endorsements
    WHERE check_id = NEW.check_id
      AND status NOT IN ('signed','waived')
      AND (payee_id = NEW.id OR payee_id IS NULL)
      AND lower(trim(payee_name)) = lower(trim(OLD.payee_name));
  END IF;

  INSERT INTO public.check_endorsements (
    check_id, tenant_id, payee_id, payee_name, payee_type,
    status, signature_method, contact_email, contact_phone, signed_at
  ) VALUES (
    NEW.check_id, v_tenant, NEW.id, NEW.payee_name, v_type,
    CASE
      WHEN NEW.endorsed_at IS NOT NULL THEN 'signed'
      WHEN NEW.endorsement_status IN ('signed','endorsed','complete','completed') THEN 'signed'
      WHEN NEW.endorsement_status = 'waived' THEN 'waived'
      ELSE 'pending'
    END,
    'portal', NEW.contact_email, NEW.contact_phone, NEW.endorsed_at
  )
  ON CONFLICT (check_id, COALESCE(payee_id, '00000000-0000-0000-0000-000000000000'), lower(trim(payee_name)))
  DO UPDATE SET
    payee_id = EXCLUDED.payee_id,
    payee_type = EXCLUDED.payee_type,
    contact_email = COALESCE(EXCLUDED.contact_email, check_endorsements.contact_email),
    contact_phone = COALESCE(EXCLUDED.contact_phone, check_endorsements.contact_phone),
    status = CASE
      WHEN check_endorsements.status IN ('signed', 'waived') THEN check_endorsements.status
      ELSE EXCLUDED.status
    END,
    signed_at = COALESCE(check_endorsements.signed_at, EXCLUDED.signed_at),
    updated_at = now();

  RETURN NEW;
END;
$function$;

-- Clean up existing orphaned unsigned endorsement rows left by past renames.
DELETE FROM public.check_endorsements e
USING public.check_payees p
WHERE e.payee_id = p.id
  AND e.status NOT IN ('signed','waived')
  AND lower(trim(e.payee_name)) <> lower(trim(p.payee_name));