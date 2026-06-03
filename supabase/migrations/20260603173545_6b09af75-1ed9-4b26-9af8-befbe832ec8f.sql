-- Add policy for shared loss draft releases
CREATE POLICY "Target tenant can view shared loss draft releases" ON public.loss_draft_releases
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.loss_draft_tracking ldt
    JOIN public.shared_checks sc ON sc.check_id = ldt.check_intake_item_id
    WHERE ldt.id = loss_draft_releases.loss_draft_id
    AND sc.revoked_at IS NULL
    AND user_belongs_to_tenant(auth.uid(), sc.target_tenant_id)
  )
);
