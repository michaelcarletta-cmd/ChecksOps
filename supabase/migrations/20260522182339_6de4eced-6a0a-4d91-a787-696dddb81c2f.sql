
CREATE POLICY "Target tenant can update shared endorsements"
ON public.check_endorsements
FOR UPDATE
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.shared_checks sc
    WHERE sc.check_id = check_endorsements.check_id
      AND sc.revoked_at IS NULL
      AND public.user_belongs_to_tenant(auth.uid(), sc.target_tenant_id)
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.shared_checks sc
    WHERE sc.check_id = check_endorsements.check_id
      AND sc.revoked_at IS NULL
      AND public.user_belongs_to_tenant(auth.uid(), sc.target_tenant_id)
  )
);
