-- Helper: is the user privileged staff (admin/operator) within a tenant?
CREATE OR REPLACE FUNCTION public.is_tenant_staff(_user_id uuid, _tenant_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.tenant_users
    WHERE user_id = _user_id
      AND tenant_id = _tenant_id
      AND role IN ('admin', 'operator')
  )
$$;

-- Helper: is the user a member of an org?
CREATE OR REPLACE FUNCTION public.is_org_member(_user_id uuid, _org_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.org_members
    WHERE user_id = _user_id AND org_id = _org_id
  )
$$;

-- 1) tenants: restrict base-table reads to platform admins + tenant staff (admin/operator)
DROP POLICY IF EXISTS "Members can view their tenant" ON public.tenants;
CREATE POLICY "Tenant staff can view their tenant"
ON public.tenants FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'admin'::app_role)
  OR public.is_master_owner()
  OR public.is_tenant_staff(auth.uid(), id)
);

-- Non-sensitive tenant profile view for general member-facing use
CREATE OR REPLACE VIEW public.tenant_safe
WITH (security_invoker = off) AS
SELECT
  id, name, slug, logo_url, primary_color, secondary_color, custom_domain,
  subscription_status, plan_tier, is_system_tenant, max_checks_per_month,
  created_at, updated_at,
  email_from_name, email_from_address, email_reply_to, email_provider,
  partner_code, per_check_billing_enabled, per_check_rate_cents,
  referral_code, referral_discount_cents, referred_by_tenant_id,
  is_founding_partner, monthly_rate_cents, data_retention_years,
  legal_business_name, business_address, business_phone,
  kyc_status, actum_credits_only, payment_rail, payment_provider,
  payment_status, bank_connection_status, bank_name, bank_last_four,
  verification_status, moov_allowlisted, moov_environment,
  invoice_letterhead_url, invoice_footer_note, invoice_default_terms,
  invoice_accent_color, invoice_theme,
  max_sales_reps, max_subcontractors, max_vendors,
  vendor_cap, sales_rep_cap, subcontractor_cap, stakeholder_cap,
  is_test_account
FROM public.tenants t
WHERE public.is_tenant_member(auth.uid(), t.id)
   OR public.has_role(auth.uid(), 'admin'::app_role)
   OR public.is_master_owner();

GRANT SELECT ON public.tenant_safe TO authenticated;

-- 2) stakeholder_accounts: scope to tenant staff (admin/operator) + platform admins
DROP POLICY IF EXISTS tenant_isolation_stakeholder_accounts ON public.stakeholder_accounts;
CREATE POLICY "Tenant staff can view stakeholder accounts"
ON public.stakeholder_accounts FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'admin'::app_role)
  OR public.is_master_owner()
  OR public.is_tenant_staff(auth.uid(), tenant_id)
);
CREATE POLICY "Tenant staff can add stakeholder accounts"
ON public.stakeholder_accounts FOR INSERT TO authenticated
WITH CHECK (
  public.has_role(auth.uid(), 'admin'::app_role)
  OR public.is_master_owner()
  OR public.is_tenant_staff(auth.uid(), tenant_id)
);
CREATE POLICY "Tenant staff can update stakeholder accounts"
ON public.stakeholder_accounts FOR UPDATE TO authenticated
USING (
  public.has_role(auth.uid(), 'admin'::app_role)
  OR public.is_master_owner()
  OR public.is_tenant_staff(auth.uid(), tenant_id)
)
WITH CHECK (
  public.has_role(auth.uid(), 'admin'::app_role)
  OR public.is_master_owner()
  OR public.is_tenant_staff(auth.uid(), tenant_id)
);
CREATE POLICY "Tenant staff can delete stakeholder accounts"
ON public.stakeholder_accounts FOR DELETE TO authenticated
USING (
  public.has_role(auth.uid(), 'admin'::app_role)
  OR public.is_master_owner()
  OR public.is_tenant_staff(auth.uid(), tenant_id)
);

-- 3) mortgage_desk_config: restrict reads to admin/staff/mortgage agents
DROP POLICY IF EXISTS "authenticated can read mortgage desk config" ON public.mortgage_desk_config;
CREATE POLICY "Staff can read mortgage desk config"
ON public.mortgage_desk_config FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'admin'::app_role)
  OR public.has_role(auth.uid(), 'staff'::app_role)
  OR public.has_role(auth.uid(), 'mortgage_agent'::app_role)
  OR public.is_master_owner()
);

-- 4) orgs: scope directory visibility to org members
DROP POLICY IF EXISTS "Authenticated users can view orgs" ON public.orgs;
CREATE POLICY "Org members can view their orgs"
ON public.orgs FOR SELECT TO authenticated
USING (
  public.is_org_member(auth.uid(), id)
  OR public.has_role(auth.uid(), 'admin'::app_role)
  OR public.is_master_owner()
);