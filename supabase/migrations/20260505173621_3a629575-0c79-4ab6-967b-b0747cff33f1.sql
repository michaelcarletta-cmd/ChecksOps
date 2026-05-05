CREATE TABLE IF NOT EXISTS public.tenant_partner_code_aliases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.tenant_partner_code_aliases ENABLE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX IF NOT EXISTS tenant_partner_code_aliases_code_upper_key
  ON public.tenant_partner_code_aliases (upper(btrim(code)));

CREATE UNIQUE INDEX IF NOT EXISTS tenant_partner_code_aliases_tenant_id_code_upper_key
  ON public.tenant_partner_code_aliases (tenant_id, upper(btrim(code)));

CREATE OR REPLACE FUNCTION public.lookup_tenant_by_partner_code(_code text)
RETURNS TABLE(id uuid, name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH normalized AS (
    SELECT regexp_replace(upper(coalesce(_code, '')), '[^A-Z0-9]', '', 'g') AS code
  )
  SELECT DISTINCT t.id, t.name
  FROM normalized n
  JOIN public.tenants t
    ON t.subscription_status = 'active'
   AND t.partner_code = n.code

  UNION

  SELECT DISTINCT t.id, t.name
  FROM normalized n
  JOIN public.tenant_partner_code_aliases a
    ON upper(btrim(a.code)) = n.code
  JOIN public.tenants t
    ON t.id = a.tenant_id
   AND t.subscription_status = 'active'
  LIMIT 1;
$function$;

GRANT EXECUTE ON FUNCTION public.lookup_tenant_by_partner_code(text) TO authenticated;

INSERT INTO public.tenant_partner_code_aliases (tenant_id, code)
SELECT id, 'FF0CBBD8'
FROM public.tenants
WHERE slug = 'freedom'
ON CONFLICT (tenant_id, upper(btrim(code))) DO NOTHING;