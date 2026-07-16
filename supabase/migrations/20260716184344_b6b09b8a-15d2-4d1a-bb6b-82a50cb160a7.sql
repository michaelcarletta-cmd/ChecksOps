CREATE POLICY "recipient_name_tenant_read_disbursement_splits"
ON public.disbursement_splits FOR SELECT
TO authenticated
USING (
  recipient_name IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM public.tenant_users tu
    JOIN public.tenants t ON t.id = tu.tenant_id
    WHERE tu.user_id = auth.uid()
      AND lower(trim(t.name)) = lower(trim(disbursement_splits.recipient_name))
  )
);