
-- Security-definer helper: does the current user's tenant appear as recipient
-- (via stakeholder account OR recipient_name match) on any settled disbursement
-- split whose batch points at this check_intake_item?
CREATE OR REPLACE FUNCTION public.current_tenant_is_check_funds_recipient(_check_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.disbursement_splits ds
    JOIN public.disbursement_batches db ON db.id = ds.batch_id
    LEFT JOIN public.stakeholder_accounts sa ON sa.id = ds.stakeholder_account_id
    LEFT JOIN public.tenants t ON lower(trim(t.name)) = lower(trim(ds.recipient_name))
    WHERE db.check_intake_item_id = _check_id
      AND ds.status = 'settled'
      AND (
        sa.tenant_id IN (SELECT tu.tenant_id FROM public.tenant_users tu WHERE tu.user_id = auth.uid())
        OR t.id IN (SELECT tu.tenant_id FROM public.tenant_users tu WHERE tu.user_id = auth.uid())
      )
  )
$$;

-- Same helper for claims: any check on this claim where I'm the recipient.
CREATE OR REPLACE FUNCTION public.current_tenant_is_claim_funds_recipient(_claim_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.check_intake_items cii
    WHERE cii.claim_id = _claim_id
      AND public.current_tenant_is_check_funds_recipient(cii.id)
  )
$$;

CREATE POLICY "Recipient tenant can view check funds received"
ON public.check_intake_items FOR SELECT
TO authenticated
USING (public.current_tenant_is_check_funds_recipient(id));

CREATE POLICY "Recipient tenant can view claim of funds received"
ON public.claims FOR SELECT
TO authenticated
USING (public.current_tenant_is_claim_funds_recipient(id));
