
ALTER TABLE public.disbursement_splits
  ADD COLUMN IF NOT EXISTS recipient_tenant_id uuid REFERENCES public.tenants(id);

ALTER TABLE public.external_payment_recipients
  ADD COLUMN IF NOT EXISTS recipient_tenant_id uuid REFERENCES public.tenants(id);

CREATE INDEX IF NOT EXISTS idx_disbursement_splits_recipient_tenant
  ON public.disbursement_splits(recipient_tenant_id);

CREATE OR REPLACE FUNCTION public.normalize_org_name(_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT nullif(
    btrim(
      regexp_replace(
        regexp_replace(
          lower(coalesce(_name, '')),
          '[^a-z0-9 ]', ' ', 'g'
        ),
        '\s+(llc|l l c|inc|incorporated|corp|corporation|co|company|ltd|limited|lp|llp|pllc|group|holdings)\s*$',
        '', 'g'
      )
    ),
    ''
  );
$$;

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

  -- exact normalized match
  SELECT t.id INTO v_tenant
  FROM public.tenants t
  WHERE public.normalize_org_name(t.name) = v_norm
  LIMIT 2;

  IF v_tenant IS NOT NULL THEN
    RETURN v_tenant;
  END IF;

  -- unique containment match ("Barzzini Construction" <-> "Barzzini Construction Group")
  SELECT id INTO v_tenant
  FROM (
    SELECT t.id
    FROM public.tenants t
    WHERE public.normalize_org_name(t.name) IS NOT NULL
      AND (
        public.normalize_org_name(t.name) LIKE v_norm || ' %'
        OR v_norm LIKE public.normalize_org_name(t.name) || ' %'
      )
    LIMIT 2
  ) m
  HAVING count(*) = 1;

  RETURN v_tenant;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_set_split_recipient_tenant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.recipient_tenant_id IS NULL THEN
    NEW.recipient_tenant_id := public.resolve_recipient_tenant(NEW.recipient_name, NEW.stakeholder_account_id);
  END IF;
  IF NEW.recipient_tenant_id = NEW.tenant_id THEN
    NEW.recipient_tenant_id := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_split_recipient_tenant ON public.disbursement_splits;
CREATE TRIGGER set_split_recipient_tenant
  BEFORE INSERT OR UPDATE OF recipient_name, stakeholder_account_id ON public.disbursement_splits
  FOR EACH ROW EXECUTE FUNCTION public.trg_set_split_recipient_tenant();

CREATE OR REPLACE FUNCTION public.get_tenant_funds_received(_tenant_id uuid)
RETURNS TABLE(id uuid, amount numeric, settled_at timestamp with time zone, created_at timestamp with time zone, recipient_name text, method text, external_check_number text, tenant_id uuid, sender_name text, check_intake_item_id uuid, check_number text, carrier_name text, property_address text, funds_type text, check_amount numeric, claim_id uuid, detected_claim_number text, payee_line text, claim_number text, policyholder_name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    ds.id,
    ds.amount,
    ds.settled_at,
    ds.created_at,
    ds.recipient_name,
    ds.method,
    ds.external_check_number,
    ds.tenant_id,
    sender.name AS sender_name,
    db.check_intake_item_id,
    cii.check_number,
    cii.carrier_name,
    cii.property_address,
    cii.funds_type,
    cii.amount AS check_amount,
    cii.claim_id,
    cii.detected_claim_number,
    cii.payee_line,
    claims.claim_number,
    claims.policyholder_name
  FROM public.disbursement_splits ds
  JOIN public.disbursement_batches db ON db.id = ds.batch_id
  LEFT JOIN public.stakeholder_accounts sa ON sa.id = ds.stakeholder_account_id
  LEFT JOIN public.tenants sender ON sender.id = ds.tenant_id
  LEFT JOIN public.check_intake_items cii ON cii.id = db.check_intake_item_id
  LEFT JOIN public.claims ON claims.id = cii.claim_id
  WHERE ds.status = 'settled'
    AND ds.tenant_id <> _tenant_id
    AND (
      ds.recipient_tenant_id = _tenant_id
      OR sa.tenant_id = _tenant_id
      OR public.normalize_org_name(ds.recipient_name) = (
        SELECT public.normalize_org_name(t.name) FROM public.tenants t WHERE t.id = _tenant_id
      )
    )
    AND EXISTS (
      SELECT 1
      FROM public.tenant_users tu
      WHERE tu.tenant_id = _tenant_id
        AND tu.user_id = auth.uid()
    )
  ORDER BY ds.settled_at DESC NULLS LAST, ds.created_at DESC;
$$;
