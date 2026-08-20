
CREATE OR REPLACE FUNCTION public.resolve_recipient_tenant(_recipient_name text, _stakeholder_account_id uuid)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant uuid;
  v_norm text;
  v_count int;
BEGIN
  IF _stakeholder_account_id IS NOT NULL THEN
    SELECT sa.tenant_id INTO v_tenant
    FROM public.stakeholder_accounts sa
    WHERE sa.id = _stakeholder_account_id;
    IF v_tenant IS NOT NULL THEN
      RETURN v_tenant;
    END IF;
  END IF;

  v_norm := public.normalize_org_name(_recipient_name);
  IF v_norm IS NULL OR length(v_norm) < 5 THEN
    RETURN NULL;
  END IF;

  SELECT t.id INTO v_tenant
  FROM public.tenants t
  WHERE public.normalize_org_name(t.name) = v_norm
  LIMIT 1;

  IF v_tenant IS NOT NULL THEN
    RETURN v_tenant;
  END IF;

  SELECT count(*), min(t.id::text)::uuid INTO v_count, v_tenant
  FROM public.tenants t
  WHERE public.normalize_org_name(t.name) IS NOT NULL
    AND (
      public.normalize_org_name(t.name) LIKE v_norm || ' %'
      OR v_norm LIKE public.normalize_org_name(t.name) || ' %'
    );

  IF v_count = 1 THEN
    RETURN v_tenant;
  END IF;

  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.resolve_recipient_tenant(text, uuid) FROM anon, authenticated;
