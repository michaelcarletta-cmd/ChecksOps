-- Drop overly-broad ALL policies and split into tenant-scoped read/write
DROP POLICY IF EXISTS "Staff can manage check_intake_items" ON public.check_intake_items;
DROP POLICY IF EXISTS "Target tenant can view shared checks" ON public.check_intake_items;
DROP POLICY IF EXISTS "Staff can manage check_payees" ON public.check_payees;

-- ===== check_intake_items =====

-- Staff/admin can VIEW checks owned by their tenant
CREATE POLICY "Owner tenant staff can view checks"
ON public.check_intake_items
FOR SELECT
USING (
  (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'staff'::app_role))
  AND user_belongs_to_tenant(auth.uid(), tenant_id)
);

-- Partners (target tenants of an active share) can VIEW shared checks
CREATE POLICY "Target tenant can view shared checks"
ON public.check_intake_items
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.shared_checks sc
    WHERE sc.check_id = check_intake_items.id
      AND sc.revoked_at IS NULL
      AND user_belongs_to_tenant(auth.uid(), sc.target_tenant_id)
  )
);

-- Only owner-tenant staff/admin can INSERT
CREATE POLICY "Owner tenant staff can insert checks"
ON public.check_intake_items
FOR INSERT
WITH CHECK (
  (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'staff'::app_role))
  AND user_belongs_to_tenant(auth.uid(), tenant_id)
);

-- Only owner-tenant staff/admin can UPDATE
CREATE POLICY "Owner tenant staff can update checks"
ON public.check_intake_items
FOR UPDATE
USING (
  (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'staff'::app_role))
  AND user_belongs_to_tenant(auth.uid(), tenant_id)
)
WITH CHECK (
  (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'staff'::app_role))
  AND user_belongs_to_tenant(auth.uid(), tenant_id)
);

-- Only owner-tenant staff/admin can DELETE
CREATE POLICY "Owner tenant staff can delete checks"
ON public.check_intake_items
FOR DELETE
USING (
  (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'staff'::app_role))
  AND user_belongs_to_tenant(auth.uid(), tenant_id)
);

-- ===== check_payees =====

-- Staff/admin can VIEW payees on their tenant's checks
CREATE POLICY "Owner tenant staff can view payees"
ON public.check_payees
FOR SELECT
USING (
  (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'staff'::app_role))
  AND EXISTS (
    SELECT 1 FROM public.check_intake_items ci
    WHERE ci.id = check_payees.check_id
      AND user_belongs_to_tenant(auth.uid(), ci.tenant_id)
  )
);

-- Partners can VIEW payees of shared checks
CREATE POLICY "Target tenant can view shared payees"
ON public.check_payees
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.shared_checks sc
    WHERE sc.check_id = check_payees.check_id
      AND sc.revoked_at IS NULL
      AND user_belongs_to_tenant(auth.uid(), sc.target_tenant_id)
  )
);

-- Only owner-tenant staff/admin can INSERT payees
CREATE POLICY "Owner tenant staff can insert payees"
ON public.check_payees
FOR INSERT
WITH CHECK (
  (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'staff'::app_role))
  AND EXISTS (
    SELECT 1 FROM public.check_intake_items ci
    WHERE ci.id = check_payees.check_id
      AND user_belongs_to_tenant(auth.uid(), ci.tenant_id)
  )
);

-- Only owner-tenant staff/admin can UPDATE payees
CREATE POLICY "Owner tenant staff can update payees"
ON public.check_payees
FOR UPDATE
USING (
  (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'staff'::app_role))
  AND EXISTS (
    SELECT 1 FROM public.check_intake_items ci
    WHERE ci.id = check_payees.check_id
      AND user_belongs_to_tenant(auth.uid(), ci.tenant_id)
  )
)
WITH CHECK (
  (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'staff'::app_role))
  AND EXISTS (
    SELECT 1 FROM public.check_intake_items ci
    WHERE ci.id = check_payees.check_id
      AND user_belongs_to_tenant(auth.uid(), ci.tenant_id)
  )
);

-- Only owner-tenant staff/admin can DELETE payees
CREATE POLICY "Owner tenant staff can delete payees"
ON public.check_payees
FOR DELETE
USING (
  (has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'staff'::app_role))
  AND EXISTS (
    SELECT 1 FROM public.check_intake_items ci
    WHERE ci.id = check_payees.check_id
      AND user_belongs_to_tenant(auth.uid(), ci.tenant_id)
  )
);