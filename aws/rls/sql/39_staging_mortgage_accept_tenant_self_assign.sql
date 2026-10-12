-- STAGING ONLY.
-- Narrow WITH CHECK correction for public.aws_update_mortgage_handling_requests.
-- Preserves the existing USING expression and all prior WITH CHECK branches.
-- Adds only:
--   OR (aws_can_write_tenant(tenant_id) AND assigned_employee_id = auth.uid())
-- so a tenant-scoped writer may keep a row they already can write when they
-- assign it to themselves. Does not allow aws_can_write_tenant(tenant_id) alone.
-- Do not apply this file to production.

DROP POLICY IF EXISTS aws_update_mortgage_handling_requests ON public.mortgage_handling_requests;
CREATE POLICY aws_update_mortgage_handling_requests ON public.mortgage_handling_requests
  FOR UPDATE TO authenticated
  USING (
    aws_is_cross_tenant_reader()
    OR aws_can_write_tenant(tenant_id)
    OR (
      has_role(auth.uid(), 'mortgage_agent'::app_role)
      AND (
        (status = 'requested' AND assigned_employee_id IS NULL)
        OR assigned_employee_id = auth.uid()
      )
    )
  )
  WITH CHECK (
    aws_is_cross_tenant_reader()
    OR (
      has_role(auth.uid(), 'mortgage_agent'::app_role)
      AND (
        (status = 'requested' AND assigned_employee_id IS NULL)
        OR assigned_employee_id = auth.uid()
      )
    )
    OR (
      aws_can_write_tenant(tenant_id)
      AND status = 'requested'
      AND assigned_employee_id IS NULL
    )
    OR (
      aws_can_write_tenant(tenant_id)
      AND assigned_employee_id = auth.uid()
    )
  );
