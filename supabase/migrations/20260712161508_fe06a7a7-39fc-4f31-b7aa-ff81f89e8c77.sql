
-- =========================================================================
-- 1. stakeholder_accounts.origin + is_partner_payout
-- =========================================================================
ALTER TABLE public.stakeholder_accounts
  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'tenant_owned',
  ADD COLUMN IF NOT EXISTS is_partner_payout boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS homeowner_link_token_id uuid,
  ADD COLUMN IF NOT EXISTS homeowner_email text,
  ADD COLUMN IF NOT EXISTS homeowner_name text;

DO $$ BEGIN
  ALTER TABLE public.stakeholder_accounts
    ADD CONSTRAINT stakeholder_accounts_origin_check
    CHECK (origin IN ('tenant_owned','partner_shared','homeowner_link'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Only one partner-payout account per tenant
CREATE UNIQUE INDEX IF NOT EXISTS stakeholder_accounts_one_partner_payout
  ON public.stakeholder_accounts (tenant_id)
  WHERE is_partner_payout = true AND is_active = true;

-- =========================================================================
-- 2. tenants: sales rep + subcontractor caps
-- =========================================================================
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS max_sales_reps integer NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS max_subcontractors integer NOT NULL DEFAULT 10;

-- =========================================================================
-- 3. Enforce caps on stakeholder_accounts inserts (sales_rep counted via account_type)
--    account_type 'subcontractor' already exists.
--    We reuse 'other' with a marker or add 'sales_rep' type? Add sales_rep.
-- =========================================================================
ALTER TABLE public.stakeholder_accounts
  DROP CONSTRAINT IF EXISTS stakeholder_accounts_account_type_check;
ALTER TABLE public.stakeholder_accounts
  ADD CONSTRAINT stakeholder_accounts_account_type_check
  CHECK (account_type IN (
    'operating','vendor','subcontractor','overhead','insured',
    'contractor','supplier','sales_rep','homeowner','other'
  ));

CREATE OR REPLACE FUNCTION public.enforce_stakeholder_caps()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cap integer;
  cur integer;
BEGIN
  IF NEW.account_type = 'sales_rep' THEN
    SELECT max_sales_reps INTO cap FROM public.tenants WHERE id = NEW.tenant_id;
    SELECT count(*) INTO cur FROM public.stakeholder_accounts
      WHERE tenant_id = NEW.tenant_id AND account_type = 'sales_rep' AND is_active = true;
    IF cur >= COALESCE(cap, 5) THEN
      RAISE EXCEPTION 'Sales rep limit reached (% of %). Request an increase from your admin.', cur, cap
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.account_type = 'subcontractor' THEN
    SELECT max_subcontractors INTO cap FROM public.tenants WHERE id = NEW.tenant_id;
    SELECT count(*) INTO cur FROM public.stakeholder_accounts
      WHERE tenant_id = NEW.tenant_id AND account_type = 'subcontractor' AND is_active = true;
    IF cur >= COALESCE(cap, 10) THEN
      RAISE EXCEPTION 'Subcontractor limit reached (% of %). Request an increase from your admin.', cur, cap
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_stakeholder_caps ON public.stakeholder_accounts;
CREATE TRIGGER trg_enforce_stakeholder_caps
  BEFORE INSERT ON public.stakeholder_accounts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_stakeholder_caps();

-- =========================================================================
-- 4. stakeholder_limit_requests
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.stakeholder_limit_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  requested_by uuid NOT NULL REFERENCES auth.users(id),
  category text NOT NULL CHECK (category IN ('sales_rep','subcontractor')),
  requested_limit integer NOT NULL CHECK (requested_limit > 0),
  reason text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied')),
  reviewed_by uuid REFERENCES auth.users(id),
  reviewed_at timestamptz,
  review_notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON public.stakeholder_limit_requests TO authenticated;
GRANT ALL ON public.stakeholder_limit_requests TO service_role;

ALTER TABLE public.stakeholder_limit_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant members see own requests"
  ON public.stakeholder_limit_requests FOR SELECT
  TO authenticated
  USING (
    tenant_id IN (SELECT tenant_id FROM public.tenant_users WHERE user_id = auth.uid())
    OR public.has_role(auth.uid(), 'admin')
  );

CREATE POLICY "tenant members create own requests"
  ON public.stakeholder_limit_requests FOR INSERT
  TO authenticated
  WITH CHECK (
    requested_by = auth.uid()
    AND tenant_id IN (SELECT tenant_id FROM public.tenant_users WHERE user_id = auth.uid())
  );

CREATE POLICY "system admins review"
  ON public.stakeholder_limit_requests FOR UPDATE
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER trg_stakeholder_limit_requests_updated_at
  BEFORE UPDATE ON public.stakeholder_limit_requests
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- =========================================================================
-- 5. homeowner_bank_link_tokens
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.homeowner_bank_link_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  sent_by_user_id uuid NOT NULL REFERENCES auth.users(id),
  scope text NOT NULL CHECK (scope IN ('check','claim')),
  check_intake_item_id uuid REFERENCES public.check_intake_items(id) ON DELETE CASCADE,
  claim_id uuid REFERENCES public.claims(id) ON DELETE CASCADE,
  homeowner_name text NOT NULL,
  homeowner_email text NOT NULL,
  token text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','opened','verified','expired','revoked')),
  stakeholder_account_id uuid REFERENCES public.stakeholder_accounts(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '14 days'),
  opened_at timestamptz,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT homeowner_bank_link_scope_target CHECK (
    (scope = 'check' AND check_intake_item_id IS NOT NULL) OR
    (scope = 'claim' AND claim_id IS NOT NULL)
  )
);

GRANT SELECT, INSERT, UPDATE ON public.homeowner_bank_link_tokens TO authenticated;
GRANT ALL ON public.homeowner_bank_link_tokens TO service_role;

CREATE INDEX IF NOT EXISTS idx_homeowner_bank_link_tenant
  ON public.homeowner_bank_link_tokens(tenant_id);
CREATE INDEX IF NOT EXISTS idx_homeowner_bank_link_claim
  ON public.homeowner_bank_link_tokens(claim_id) WHERE claim_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_homeowner_bank_link_check
  ON public.homeowner_bank_link_tokens(check_intake_item_id) WHERE check_intake_item_id IS NOT NULL;

ALTER TABLE public.homeowner_bank_link_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant members manage own bank links"
  ON public.homeowner_bank_link_tokens FOR ALL
  TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_users WHERE user_id = auth.uid()))
  WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.tenant_users WHERE user_id = auth.uid()));

CREATE TRIGGER trg_homeowner_bank_link_tokens_updated_at
  BEFORE UPDATE ON public.homeowner_bank_link_tokens
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.stakeholder_accounts
  ADD CONSTRAINT stakeholder_accounts_homeowner_link_fk
  FOREIGN KEY (homeowner_link_token_id)
  REFERENCES public.homeowner_bank_link_tokens(id) ON DELETE SET NULL;

-- =========================================================================
-- 6. Auto-add partner as check stakeholder on share
-- =========================================================================
CREATE OR REPLACE FUNCTION public.autoadd_partner_stakeholder_on_share()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  payout_account_id uuid;
BEGIN
  -- Pick the partner's designated payout account (falls back to primary verified account)
  SELECT id INTO payout_account_id
  FROM public.stakeholder_accounts
  WHERE tenant_id = NEW.target_tenant_id
    AND is_active = true
    AND verification_status IN ('verified','admin_override')
    AND is_partner_payout = true
  LIMIT 1;

  IF payout_account_id IS NULL THEN
    SELECT id INTO payout_account_id
    FROM public.stakeholder_accounts
    WHERE tenant_id = NEW.target_tenant_id
      AND is_active = true
      AND verification_status IN ('verified','admin_override')
    ORDER BY is_primary DESC, created_at ASC
    LIMIT 1;
  END IF;

  -- Idempotent insert (unique on check + partner)
  INSERT INTO public.check_stakeholders (
    check_intake_item_id, stakeholder_account_id, tenant_id,
    added_via, partner_tenant_id, added_by
  ) VALUES (
    NEW.check_id, payout_account_id, NEW.source_tenant_id,
    'partner_share', NEW.target_tenant_id, NEW.shared_by
  )
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_autoadd_partner_stakeholder ON public.shared_checks;
CREATE TRIGGER trg_autoadd_partner_stakeholder
  AFTER INSERT ON public.shared_checks
  FOR EACH ROW
  WHEN (NEW.revoked_at IS NULL)
  EXECUTE FUNCTION public.autoadd_partner_stakeholder_on_share();

-- Prevent duplicate partner stakeholder rows per check
CREATE UNIQUE INDEX IF NOT EXISTS check_stakeholders_unique_partner
  ON public.check_stakeholders(check_intake_item_id, partner_tenant_id)
  WHERE partner_tenant_id IS NOT NULL;
