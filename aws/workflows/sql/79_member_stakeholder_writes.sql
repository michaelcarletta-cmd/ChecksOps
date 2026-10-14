-- Let any member of a check owner's tenant add and remove that check's
-- stakeholders, without a platform admin/staff role.
--
-- The existing aws_write_check_stakeholders and
-- aws_write_check_partner_stakeholder_removals policies require
-- aws_can_write_tenant() (tenant member with user_roles admin/staff, or a
-- cross-tenant reader). These additional permissive policies allow INSERT and
-- DELETE when the row's tenant is one of the caller's own tenant_users tenants
-- (aws_user_tenant_ids()). Partner tenants a check is shared with, and
-- cross-tenant readers who are not members, gain nothing. There is no UPDATE
-- grant on either table, so no UPDATE policy is added.
-- A member's check_stakeholders insert must also be a manual link on a check
-- the row's tenant owns (the EXISTS runs under check_intake_items RLS, which
-- lets a member read its own tenant's checks). Removal rows are already bound
-- to the owner's share of the check by their composite foreign key.
-- Plain CREATE POLICY: re-applying fails instead of silently replacing a policy.
--
-- Writer: aws/functions/api/write-check-workflow.mjs (executeCheckStakeholders,
--         executeCheckPartnerStakeholderRemovals).

CREATE POLICY aws_member_insert_check_stakeholders ON public.check_stakeholders
  FOR INSERT TO authenticated
  WITH CHECK (
    public.aws_is_authenticated()
    AND tenant_id IN (SELECT public.aws_user_tenant_ids())
    AND EXISTS (
      SELECT 1 FROM public.check_intake_items c
      WHERE c.id = check_intake_item_id AND c.tenant_id = check_stakeholders.tenant_id
    )
    AND added_via = 'manual'
  );

CREATE POLICY aws_member_delete_check_stakeholders ON public.check_stakeholders
  FOR DELETE TO authenticated
  USING (
    public.aws_is_authenticated()
    AND tenant_id IN (SELECT public.aws_user_tenant_ids())
  );

CREATE POLICY aws_member_insert_check_partner_stakeholder_removals ON public.check_partner_stakeholder_removals
  FOR INSERT TO authenticated
  WITH CHECK (
    public.aws_is_authenticated()
    AND tenant_id IN (SELECT public.aws_user_tenant_ids())
  );

CREATE POLICY aws_member_delete_check_partner_stakeholder_removals ON public.check_partner_stakeholder_removals
  FOR DELETE TO authenticated
  USING (
    public.aws_is_authenticated()
    AND tenant_id IN (SELECT public.aws_user_tenant_ids())
  );
