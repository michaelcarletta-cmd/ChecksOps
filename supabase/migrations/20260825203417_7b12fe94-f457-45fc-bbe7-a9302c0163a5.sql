-- 1) claims: read_only must also belong to the claim's org
DROP POLICY IF EXISTS "Authenticated users with roles can view claims" ON public.claims;
CREATE POLICY "Authenticated users with roles can view claims"
ON public.claims FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'admin'::app_role)
  OR public.has_role(auth.uid(), 'staff'::app_role)
  OR (public.has_role(auth.uid(), 'read_only'::app_role) AND public.is_org_member(auth.uid(), org_id))
);

-- 2) claim_events: scope read_only via parent claim's org
DROP POLICY IF EXISTS claim_events_select ON public.claim_events;
CREATE POLICY claim_events_select
ON public.claim_events FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'admin'::app_role)
  OR public.has_role(auth.uid(), 'staff'::app_role)
  OR (
    public.has_role(auth.uid(), 'read_only'::app_role)
    AND EXISTS (
      SELECT 1 FROM public.claims c
      WHERE c.id = claim_events.claim_id
        AND public.is_org_member(auth.uid(), c.org_id)
    )
  )
);

-- 3) extracted_document_data: scope read_only via parent claim's org
DROP POLICY IF EXISTS "Staff can view extracted data" ON public.extracted_document_data;
CREATE POLICY "Staff can view extracted data"
ON public.extracted_document_data FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'admin'::app_role)
  OR public.has_role(auth.uid(), 'staff'::app_role)
  OR (
    public.has_role(auth.uid(), 'read_only'::app_role)
    AND EXISTS (
      SELECT 1 FROM public.claims c
      WHERE c.id = extracted_document_data.claim_id
        AND public.is_org_member(auth.uid(), c.org_id)
    )
  )
);

-- 4) check_intake_items: read_only must belong to the row's tenant
DROP POLICY IF EXISTS "Read-only can view check_intake_items" ON public.check_intake_items;
CREATE POLICY "Read-only can view check_intake_items"
ON public.check_intake_items FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'read_only'::app_role)
  AND public.is_tenant_member(auth.uid(), tenant_id)
);

-- 5) check_payees: read_only must belong to the row's tenant
DROP POLICY IF EXISTS "Read-only can view check_payees" ON public.check_payees;
CREATE POLICY "Read-only can view check_payees"
ON public.check_payees FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'read_only'::app_role)
  AND public.is_tenant_member(auth.uid(), tenant_id)
);

-- 6) check_audit_log: read_only must belong to the row's tenant
DROP POLICY IF EXISTS "Read-only can view check_audit_log" ON public.check_audit_log;
CREATE POLICY "Read-only can view check_audit_log"
ON public.check_audit_log FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'read_only'::app_role)
  AND public.is_tenant_member(auth.uid(), tenant_id)
);

-- 7) loss_draft_tracking: scope read_only via parent claim's org
DROP POLICY IF EXISTS "Read-only can view loss drafts" ON public.loss_draft_tracking;
CREATE POLICY "Read-only can view loss drafts"
ON public.loss_draft_tracking FOR SELECT TO authenticated
USING (
  public.is_read_only(auth.uid())
  AND EXISTS (
    SELECT 1 FROM public.claims c
    WHERE c.id = loss_draft_tracking.claim_id
      AND public.is_org_member(auth.uid(), c.org_id)
  )
);

-- 8) loss_draft_documents: scope read_only via loss draft -> claim -> org
DROP POLICY IF EXISTS "Read-only can view draft docs" ON public.loss_draft_documents;
CREATE POLICY "Read-only can view draft docs"
ON public.loss_draft_documents FOR SELECT TO authenticated
USING (
  public.is_read_only(auth.uid())
  AND EXISTS (
    SELECT 1 FROM public.loss_draft_tracking ldt
    JOIN public.claims c ON c.id = ldt.claim_id
    WHERE ldt.id = loss_draft_documents.loss_draft_id
      AND public.is_org_member(auth.uid(), c.org_id)
  )
);

-- 9) loss_draft_releases: scope read_only via loss draft -> claim -> org
DROP POLICY IF EXISTS "Read-only can view releases" ON public.loss_draft_releases;
CREATE POLICY "Read-only can view releases"
ON public.loss_draft_releases FOR SELECT TO authenticated
USING (
  public.is_read_only(auth.uid())
  AND EXISTS (
    SELECT 1 FROM public.loss_draft_tracking ldt
    JOIN public.claims c ON c.id = ldt.claim_id
    WHERE ldt.id = loss_draft_releases.loss_draft_id
      AND public.is_org_member(auth.uid(), c.org_id)
  )
);

-- 10) checkalt_deposits: remove the null-tenant open bypass (admins/master owner keep access)
DROP POLICY IF EXISTS "Tenant members can view their checkalt deposits" ON public.checkalt_deposits;
CREATE POLICY "Tenant members can view their checkalt deposits"
ON public.checkalt_deposits FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'admin'::app_role)
  OR public.is_master_owner()
  OR (tenant_id IS NOT NULL AND public.user_belongs_to_tenant(auth.uid(), tenant_id))
);