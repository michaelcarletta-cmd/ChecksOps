CREATE OR REPLACE FUNCTION public.get_tenant_funds_received(_tenant_id uuid)
RETURNS TABLE (
  id uuid,
  amount numeric,
  settled_at timestamptz,
  created_at timestamptz,
  recipient_name text,
  method text,
  external_check_number text,
  tenant_id uuid,
  sender_name text,
  check_intake_item_id uuid,
  check_number text,
  carrier_name text,
  property_address text,
  funds_type text,
  check_amount numeric,
  claim_id uuid,
  detected_claim_number text,
  payee_line text,
  claim_number text,
  policyholder_name text
)
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
  LEFT JOIN public.tenants recipient_by_name ON lower(trim(recipient_by_name.name)) = lower(trim(ds.recipient_name))
  LEFT JOIN public.tenants sender ON sender.id = ds.tenant_id
  LEFT JOIN public.check_intake_items cii ON cii.id = db.check_intake_item_id
  LEFT JOIN public.claims ON claims.id = cii.claim_id
  WHERE ds.status = 'settled'
    AND ds.tenant_id <> _tenant_id
    AND (
      sa.tenant_id = _tenant_id
      OR recipient_by_name.id = _tenant_id
    )
    AND EXISTS (
      SELECT 1
      FROM public.tenant_users tu
      WHERE tu.tenant_id = _tenant_id
        AND tu.user_id = auth.uid()
    )
  ORDER BY ds.settled_at DESC NULLS LAST, ds.created_at DESC;
$$;

GRANT EXECUTE ON FUNCTION public.get_tenant_funds_received(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_tenant_funds_received(uuid) TO service_role;

CREATE POLICY "recipient_tenant_read_disbursement_batches"
ON public.disbursement_batches
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.disbursement_splits ds
    LEFT JOIN public.stakeholder_accounts sa ON sa.id = ds.stakeholder_account_id
    LEFT JOIN public.tenants recipient_by_name ON lower(trim(recipient_by_name.name)) = lower(trim(ds.recipient_name))
    JOIN public.tenant_users tu ON tu.user_id = auth.uid()
    WHERE ds.batch_id = disbursement_batches.id
      AND ds.status = 'settled'
      AND ds.tenant_id <> tu.tenant_id
      AND (
        sa.tenant_id = tu.tenant_id
        OR recipient_by_name.id = tu.tenant_id
      )
  )
);