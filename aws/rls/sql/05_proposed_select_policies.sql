-- PROPOSED AWS staging SELECT policies. DO NOT RUN in this phase.
-- Do not ENABLE ROW LEVEL SECURITY on restored tables here.
-- Session identity: auth.uid() = request.app_user_id = identity_accounts.application_user_id.
-- Rewrite original TO public → TO authenticated. Omit INSERT/UPDATE/DELETE until write cutover.

-- Pattern A — tenant-scoped operational data (checks, deposits, vetting, …)
-- CREATE POLICY aws_select_check_intake_items ON public.check_intake_items
--   FOR SELECT TO authenticated
--   USING (
--     public.aws_is_cross_tenant_reader()
--     OR tenant_id IN (SELECT public.aws_user_tenant_ids())
--     OR public.current_tenant_is_check_funds_recipient(id)
--     OR (
--       public.has_role(auth.uid(), 'mortgage_agent'::public.app_role)
--       AND public.mortgage_agent_can_view_check(id)
--     )
--   );

-- Pattern B — tenants directory (staff sees membership only; not every user_roles.admin)
-- CREATE POLICY aws_select_tenants ON public.tenants
--   FOR SELECT TO authenticated
--   USING (
--     public.aws_is_cross_tenant_reader()
--     OR public.is_tenant_staff(auth.uid(), id)
--     OR id IN (SELECT public.aws_user_tenant_ids())
--   );

-- Pattern C — claims. Original staff/admin SELECT is global and must NOT be restored.
-- CREATE POLICY aws_select_claims ON public.claims
--   FOR SELECT TO authenticated
--   USING (
--     public.aws_is_cross_tenant_reader()
--     OR org_id IN (SELECT public.aws_user_tenant_ids())
--     OR public.current_tenant_is_claim_funds_recipient(id)
--     OR (
--       public.has_role(auth.uid(), 'mortgage_agent'::public.app_role)
--       AND public.mortgage_agent_can_view_claim(id)
--     )
--   );

-- Pattern D — own-row identity tables
-- CREATE POLICY aws_select_own_profile ON public.profiles
--   FOR SELECT TO authenticated
--   USING (id = auth.uid() OR public.aws_is_cross_tenant_reader());
-- CREATE POLICY aws_select_own_roles ON public.user_roles
--   FOR SELECT TO authenticated
--   USING (user_id = auth.uid() OR public.aws_is_cross_tenant_reader());
-- CREATE POLICY aws_select_own_tenant_users ON public.tenant_users
--   FOR SELECT TO authenticated
--   USING (user_id = auth.uid() OR tenant_id IN (SELECT public.aws_user_tenant_ids())
--          OR public.aws_is_cross_tenant_reader());

-- JWT-email homeowner tables: compare lower(homeowner_email) = lower(auth.email())
-- only after GUC email is identity_accounts.email / profiles.email.

-- Never restore: service_role USING(true), anon policies, USING(true) writes,
-- public signature completion, CheckAlt webhook/deposit service_role policies.
