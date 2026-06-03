-- Add policy for shared loss draft tracking
CREATE POLICY "Target tenant can view shared loss drafts" ON public.loss_draft_tracking
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.shared_checks sc
    WHERE sc.check_id = loss_draft_tracking.check_intake_item_id
    AND sc.revoked_at IS NULL
    AND user_belongs_to_tenant(auth.uid(), sc.target_tenant_id)
  )
);

-- Add policy for shared loss draft documents
CREATE POLICY "Target tenant can view shared loss draft documents" ON public.loss_draft_documents
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.loss_draft_tracking ldt
    JOIN public.shared_checks sc ON sc.check_id = ldt.check_intake_item_id
    WHERE ldt.id = loss_draft_documents.loss_draft_id
    AND sc.revoked_at IS NULL
    AND user_belongs_to_tenant(auth.uid(), sc.target_tenant_id)
  )
);
