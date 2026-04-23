DO $$
DECLARE
  missing_count integer;
BEGIN
  UPDATE public.tenants
  SET partner_code = public.generate_partner_code_value()
  WHERE partner_code IS NULL OR btrim(partner_code) = '';

  SELECT count(*) INTO missing_count
  FROM public.tenants
  WHERE partner_code IS NULL OR btrim(partner_code) = '';

  IF missing_count > 0 THEN
    RAISE EXCEPTION 'Partner code backfill incomplete: % tenant rows still missing codes', missing_count;
  END IF;
END;
$$;

ALTER TABLE public.tenants
ALTER COLUMN partner_code SET DEFAULT public.generate_partner_code_value();

ALTER TABLE public.tenants
ALTER COLUMN partner_code SET NOT NULL;