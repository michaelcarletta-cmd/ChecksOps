-- 1. Tenant wallet funding settings
CREATE TABLE public.tenant_wallet_funding_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL UNIQUE REFERENCES public.tenants(id) ON DELETE CASCADE,
  auto_funding_enabled boolean NOT NULL DEFAULT false,
  funding_bank_account_id uuid REFERENCES public.payment_provider_methods(id) ON DELETE SET NULL,
  funding_payment_method_id text,
  funding_strategy text NOT NULL DEFAULT 'payment_shortage'
    CHECK (funding_strategy IN ('payment_shortage','target_balance','manual')),
  target_wallet_balance_cents bigint NOT NULL DEFAULT 0 CHECK (target_wallet_balance_cents >= 0),
  maximum_single_pull_cents bigint NOT NULL DEFAULT 2500000 CHECK (maximum_single_pull_cents >= 0),
  maximum_daily_pull_cents bigint NOT NULL DEFAULT 5000000 CHECK (maximum_daily_pull_cents >= 0),
  require_payment_approval boolean NOT NULL DEFAULT true,
  authorization_accepted_at timestamptz,
  authorization_accepted_by uuid,
  authorization_version text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenant_wallet_funding_settings TO authenticated;
GRANT ALL ON public.tenant_wallet_funding_settings TO service_role;
ALTER TABLE public.tenant_wallet_funding_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Tenant members read funding settings"
  ON public.tenant_wallet_funding_settings FOR SELECT TO authenticated
  USING (public.is_tenant_member(auth.uid(), tenant_id) OR public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Tenant admins insert funding settings"
  ON public.tenant_wallet_funding_settings FOR INSERT TO authenticated
  WITH CHECK (public.is_tenant_admin(auth.uid(), tenant_id) OR public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Tenant admins update funding settings"
  ON public.tenant_wallet_funding_settings FOR UPDATE TO authenticated
  USING (public.is_tenant_admin(auth.uid(), tenant_id) OR public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.is_tenant_admin(auth.uid(), tenant_id) OR public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER trg_twfs_updated_at
  BEFORE UPDATE ON public.tenant_wallet_funding_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX idx_twfs_tenant ON public.tenant_wallet_funding_settings(tenant_id);

-- 2. Wallet funding requests
CREATE TABLE public.wallet_funding_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  related_payment_id uuid REFERENCES public.disbursement_batches(id) ON DELETE SET NULL,
  related_claim_check_file_id uuid REFERENCES public.check_intake_items(id) ON DELETE SET NULL,
  moov_account_id text,
  moov_wallet_id text,
  wallet_row_id uuid REFERENCES public.payment_wallets(id) ON DELETE SET NULL,
  source_bank_account_id uuid REFERENCES public.payment_provider_methods(id) ON DELETE SET NULL,
  source_payment_method_id text,
  requested_amount_cents bigint NOT NULL CHECK (requested_amount_cents > 0),
  wallet_available_balance_at_request_cents bigint NOT NULL DEFAULT 0,
  payment_amount_cents bigint NOT NULL DEFAULT 0,
  shortage_amount_cents bigint NOT NULL DEFAULT 0,
  moov_transfer_id text,
  transfer_id uuid REFERENCES public.payment_transfers(id) ON DELETE SET NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','authorization_required','ready','initiating','pending',
                      'completed','failed','returned','canceled','action_required')),
  failure_code text,
  failure_reason text,
  strategy text NOT NULL DEFAULT 'payment_shortage',
  initiated_by uuid,
  initiated_at timestamptz,
  funds_available_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.wallet_funding_requests TO authenticated;
GRANT ALL ON public.wallet_funding_requests TO service_role;
ALTER TABLE public.wallet_funding_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Tenant members read funding requests"
  ON public.wallet_funding_requests FOR SELECT TO authenticated
  USING (public.is_tenant_member(auth.uid(), tenant_id) OR public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER trg_wfr_updated_at
  BEFORE UPDATE ON public.wallet_funding_requests
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE UNIQUE INDEX idx_wfr_idempotency ON public.wallet_funding_requests(tenant_id, idempotency_key);
CREATE INDEX idx_wfr_tenant ON public.wallet_funding_requests(tenant_id);
CREATE INDEX idx_wfr_payment ON public.wallet_funding_requests(related_payment_id);
CREATE INDEX idx_wfr_moov_transfer ON public.wallet_funding_requests(moov_transfer_id);
CREATE INDEX idx_wfr_status ON public.wallet_funding_requests(status);

-- Only one live funding request per payment.
CREATE UNIQUE INDEX idx_wfr_one_active_per_payment
  ON public.wallet_funding_requests(related_payment_id)
  WHERE status IN ('draft','authorization_required','ready','initiating','pending');

-- 3. Extend the outgoing payment record
ALTER TABLE public.disbursement_batches
  ADD COLUMN IF NOT EXISTS funding_request_id uuid REFERENCES public.wallet_funding_requests(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS funding_status text,
  ADD COLUMN IF NOT EXISTS amount_reserved_cents bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS auto_send_after_funding boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_by uuid,
  ADD COLUMN IF NOT EXISTS approved_amount_cents bigint;

ALTER TABLE public.disbursement_batches
  ADD CONSTRAINT disbursement_batches_funding_status_check
  CHECK (funding_status IS NULL OR funding_status IN
    ('not_required','awaiting_funding','funded','funding_failed','action_required','canceled'));

CREATE INDEX IF NOT EXISTS idx_disb_batches_funding_request ON public.disbursement_batches(funding_request_id);
CREATE INDEX IF NOT EXISTS idx_disb_batches_funding_status ON public.disbursement_batches(funding_status);