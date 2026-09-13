-- Partner Code immutability (Phase 1).
-- INSERT still mints a code when partner_code is NULL or blank.
-- UPDATE may not change, clear, or regenerate an assigned code.
-- This migration does not UPDATE existing tenant rows, aliases, lookup, or format.

CREATE OR REPLACE FUNCTION public.assign_tenant_partner_code()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.partner_code IS NULL OR btrim(NEW.partner_code) = '' THEN
      NEW.partner_code := public.generate_partner_code_value();
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.partner_code IS DISTINCT FROM OLD.partner_code THEN
    RAISE EXCEPTION 'tenants.partner_code is immutable once assigned'
      USING ERRCODE = '23001';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.assign_tenant_partner_code() IS
  'BEFORE INSERT OR UPDATE OF partner_code: generate on INSERT when empty; reject any UPDATE that changes the assigned code.';

DROP TRIGGER IF EXISTS trg_assign_tenant_partner_code ON public.tenants;
CREATE TRIGGER trg_assign_tenant_partner_code
BEFORE INSERT OR UPDATE OF partner_code ON public.tenants
FOR EACH ROW
EXECUTE FUNCTION public.assign_tenant_partner_code();
