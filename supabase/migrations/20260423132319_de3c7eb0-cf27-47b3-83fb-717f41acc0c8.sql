DROP TRIGGER IF EXISTS trg_generate_partner_code ON public.tenants;
DROP TRIGGER IF EXISTS trg_tenant_partner_code ON public.tenants;
DROP FUNCTION IF EXISTS public.set_tenant_partner_code();
DROP FUNCTION IF EXISTS public.generate_partner_code();

CREATE OR REPLACE FUNCTION public.generate_partner_code_value()
RETURNS TEXT
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  new_code TEXT;
  code_exists BOOLEAN;
BEGIN
  LOOP
    new_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
    SELECT EXISTS(
      SELECT 1
      FROM public.tenants
      WHERE partner_code = new_code
    ) INTO code_exists;

    EXIT WHEN NOT code_exists;
  END LOOP;

  RETURN new_code;
END;
$$;

CREATE OR REPLACE FUNCTION public.assign_tenant_partner_code()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.partner_code IS NULL OR btrim(NEW.partner_code) = '' THEN
    NEW.partner_code := public.generate_partner_code_value();
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_assign_tenant_partner_code
BEFORE INSERT OR UPDATE OF partner_code ON public.tenants
FOR EACH ROW
EXECUTE FUNCTION public.assign_tenant_partner_code();

UPDATE public.tenants
SET partner_code = public.generate_partner_code_value()
WHERE partner_code IS NULL OR btrim(partner_code) = '';