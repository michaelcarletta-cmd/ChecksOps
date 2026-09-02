-- Proposed AWS write policies for representative critical tables.
-- DO NOT ENABLE ROW LEVEL SECURITY on restored tables in this phase.
-- No USING(true)/WITH CHECK(true). No anon. No service_role.
-- Payment/provider/webhook/idempotency tables intentionally have NO write policies
-- (default-deny once RLS is enabled; server-side API only).

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
END $$;
GRANT authenticated TO checksops;

-- checks / intake
DROP POLICY IF EXISTS aws_write_check_intake_items ON public.check_intake_items;
CREATE POLICY aws_write_check_intake_items ON public.check_intake_items
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));

-- endorsements
DROP POLICY IF EXISTS aws_write_check_endorsements ON public.check_endorsements;
CREATE POLICY aws_write_check_endorsements ON public.check_endorsements
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));

-- deposits (tenant via check)
DROP POLICY IF EXISTS aws_write_deposit_items ON public.deposit_items;
CREATE POLICY aws_write_deposit_items ON public.deposit_items
  FOR ALL TO authenticated
  USING (public.aws_can_write_check(check_id))
  WITH CHECK (public.aws_can_write_check(check_id));

-- disbursements
DROP POLICY IF EXISTS aws_write_disbursement_batches ON public.disbursement_batches;
CREATE POLICY aws_write_disbursement_batches ON public.disbursement_batches
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));

-- claims (org_id is the tenant key; null org_id is not writable by tenant staff)
DROP POLICY IF EXISTS aws_write_claims ON public.claims;
CREATE POLICY aws_write_claims ON public.claims
  FOR ALL TO authenticated
  USING (public.aws_can_write_claim(id))
  WITH CHECK (public.aws_can_write_tenant(org_id));

-- claim files / folders
DROP POLICY IF EXISTS aws_write_claim_files ON public.claim_files;
CREATE POLICY aws_write_claim_files ON public.claim_files
  FOR ALL TO authenticated
  USING (public.aws_can_write_claim(claim_id))
  WITH CHECK (public.aws_can_write_claim(claim_id));

DROP POLICY IF EXISTS aws_write_claim_folders ON public.claim_folders;
CREATE POLICY aws_write_claim_folders ON public.claim_folders
  FOR ALL TO authenticated
  USING (public.aws_can_write_claim(claim_id))
  WITH CHECK (public.aws_can_write_claim(claim_id));

-- payment provider accounts (tenant-scoped app config, not webhook ingestion)
DROP POLICY IF EXISTS aws_write_payment_provider_accounts ON public.payment_provider_accounts;
CREATE POLICY aws_write_payment_provider_accounts ON public.payment_provider_accounts
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));

-- homeowner ledger
DROP POLICY IF EXISTS aws_write_homeowner_ledger_events ON public.homeowner_ledger_events;
CREATE POLICY aws_write_homeowner_ledger_events ON public.homeowner_ledger_events
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));

-- tenant settings
DROP POLICY IF EXISTS aws_write_tenant_email_settings ON public.tenant_email_settings;
CREATE POLICY aws_write_tenant_email_settings ON public.tenant_email_settings
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));

-- user/role administration: same-tenant users only; platform owners unrestricted
DROP POLICY IF EXISTS aws_write_user_roles ON public.user_roles;
CREATE POLICY aws_write_user_roles ON public.user_roles
  FOR ALL TO authenticated
  USING (
    public.aws_is_cross_tenant_reader()
    OR (
      public.aws_can_access_same_tenant_user(user_id)
      AND (
        public.has_role(auth.uid(), 'admin'::public.app_role)
        OR public.is_master_owner()
      )
    )
  )
  WITH CHECK (
    public.aws_is_cross_tenant_reader()
    OR (
      public.aws_can_access_same_tenant_user(user_id)
      AND public.has_role(auth.uid(), 'admin'::public.app_role)
    )
  );

-- tenants: members cannot rewrite another tenant row
DROP POLICY IF EXISTS aws_write_tenants ON public.tenants;
CREATE POLICY aws_write_tenants ON public.tenants
  FOR UPDATE TO authenticated
  USING (public.aws_can_write_tenant(id))
  WITH CHECK (public.aws_can_write_tenant(id));
