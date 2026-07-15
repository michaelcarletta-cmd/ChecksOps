
-- Normalize any payee_type value into one allowed by check_endorsements.
CREATE OR REPLACE FUNCTION public.normalize_endorsement_payee_type(_t text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE lower(coalesce(_t, ''))
    WHEN 'insured' THEN 'insured'
    WHEN 'homeowner' THEN 'insured'
    WHEN 'named_insured' THEN 'insured'
    WHEN 'public_adjuster' THEN 'public_adjuster'
    WHEN 'pa' THEN 'public_adjuster'
    WHEN 'mortgage_company' THEN 'mortgage_company'
    WHEN 'mortgagee' THEN 'mortgage_company'
    WHEN 'lender' THEN 'mortgage_company'
    WHEN 'contractor' THEN 'contractor'
    WHEN 'gc' THEN 'contractor'
    ELSE 'other'
  END
$$;

CREATE OR REPLACE FUNCTION public.tg_mirror_payee_to_endorsement()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant uuid;
  v_existing uuid;
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

  SELECT id INTO v_existing
  FROM public.check_endorsements
  WHERE check_id = NEW.check_id
    AND (payee_id = NEW.id
         OR (payee_id IS NULL AND lower(trim(payee_name)) = lower(trim(NEW.payee_name))))
  ORDER BY (payee_id = NEW.id) DESC, created_at ASC
  LIMIT 1;

  IF v_existing IS NULL THEN
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
    );
  ELSE
    UPDATE public.check_endorsements
    SET payee_id      = COALESCE(payee_id, NEW.id),
        payee_name    = NEW.payee_name,
        payee_type    = v_type,
        contact_email = COALESCE(NEW.contact_email, contact_email),
        contact_phone = COALESCE(NEW.contact_phone, contact_phone),
        tenant_id     = COALESCE(tenant_id, v_tenant),
        status = CASE
          WHEN status IN ('signed','waived') THEN status
          WHEN NEW.endorsed_at IS NOT NULL THEN 'signed'
          WHEN NEW.endorsement_status IN ('signed','endorsed','complete','completed') THEN 'signed'
          WHEN NEW.endorsement_status = 'waived' THEN 'waived'
          ELSE status
        END,
        signed_at  = COALESCE(signed_at, NEW.endorsed_at),
        updated_at = now()
    WHERE id = v_existing;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mirror_payee_to_endorsement_ins ON public.check_payees;
CREATE TRIGGER trg_mirror_payee_to_endorsement_ins
AFTER INSERT ON public.check_payees
FOR EACH ROW EXECUTE FUNCTION public.tg_mirror_payee_to_endorsement();

DROP TRIGGER IF EXISTS trg_mirror_payee_to_endorsement_upd ON public.check_payees;
CREATE TRIGGER trg_mirror_payee_to_endorsement_upd
AFTER UPDATE OF payee_name, payee_type, endorsement_status, endorsed_at, contact_email, contact_phone
ON public.check_payees
FOR EACH ROW EXECUTE FUNCTION public.tg_mirror_payee_to_endorsement();

DROP TRIGGER IF EXISTS trg_mirror_payee_to_endorsement_del ON public.check_payees;
CREATE TRIGGER trg_mirror_payee_to_endorsement_del
AFTER DELETE ON public.check_payees
FOR EACH ROW EXECUTE FUNCTION public.tg_mirror_payee_to_endorsement();

-- Backfill missing endorsement rows for existing payees on active checks.
INSERT INTO public.check_endorsements (
  check_id, tenant_id, payee_id, payee_name, payee_type, status, signature_method,
  contact_email, contact_phone, signed_at
)
SELECT
  p.check_id,
  COALESCE(p.tenant_id, c.tenant_id),
  p.id,
  p.payee_name,
  public.normalize_endorsement_payee_type(p.payee_type),
  CASE
    WHEN p.endorsed_at IS NOT NULL THEN 'signed'
    WHEN p.endorsement_status IN ('signed','endorsed','complete','completed') THEN 'signed'
    WHEN p.endorsement_status = 'waived' THEN 'waived'
    ELSE 'pending'
  END,
  'portal',
  p.contact_email,
  p.contact_phone,
  p.endorsed_at
FROM public.check_payees p
JOIN public.check_intake_items c ON c.id = p.check_id
WHERE COALESCE(c.status, '') <> 'deposited'
  AND NOT EXISTS (
    SELECT 1 FROM public.check_endorsements e
    WHERE e.check_id = p.check_id
      AND (e.payee_id = p.id
           OR (e.payee_id IS NULL AND lower(trim(e.payee_name)) = lower(trim(p.payee_name))))
  );

-- Link legacy OCR-seeded endorsements to matching payees by name.
UPDATE public.check_endorsements e
SET payee_id = p.id, updated_at = now()
FROM public.check_payees p
WHERE e.check_id = p.check_id
  AND e.payee_id IS NULL
  AND lower(trim(e.payee_name)) = lower(trim(p.payee_name));
