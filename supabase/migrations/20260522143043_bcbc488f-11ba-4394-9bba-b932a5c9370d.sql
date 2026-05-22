CREATE POLICY "Target tenant can view shared endorsements"
ON public.check_endorsements
FOR SELECT
USING (
  EXISTS (
    SELECT 1
    FROM public.shared_checks sc
    WHERE sc.check_id = check_endorsements.check_id
      AND sc.revoked_at IS NULL
      AND user_belongs_to_tenant(auth.uid(), sc.target_tenant_id)
  )
);

CREATE POLICY "Target tenant can view shared endorsement events"
ON public.check_endorsement_events
FOR SELECT
USING (
  EXISTS (
    SELECT 1
    FROM public.shared_checks sc
    WHERE sc.check_id = check_endorsement_events.check_id
      AND sc.revoked_at IS NULL
      AND user_belongs_to_tenant(auth.uid(), sc.target_tenant_id)
  )
);
