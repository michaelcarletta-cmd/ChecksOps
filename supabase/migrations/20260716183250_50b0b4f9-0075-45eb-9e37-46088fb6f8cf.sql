
-- Allow a tenant to see the disbursement splits where they are the RECIPIENT
-- (i.e. one of their stakeholder accounts received the funds), so a
-- "Funds Received" tab in ChecksOps can list money coming in from another tenant.
CREATE POLICY "recipient_tenant_read_disbursement_splits"
ON public.disbursement_splits
FOR SELECT
TO authenticated
USING (
  stakeholder_account_id IN (
    SELECT id FROM public.stakeholder_accounts
    WHERE tenant_id IN (
      SELECT tenant_id FROM public.tenant_users WHERE user_id = auth.uid()
    )
  )
);
