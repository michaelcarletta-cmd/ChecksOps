-- ============ 1. Transfer groups (split settlements + facilitator fee) ============
CREATE TABLE public.payment_transfer_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  provider text NOT NULL DEFAULT 'moov',
  environment text NOT NULL DEFAULT 'sandbox',
  provider_group_id text,
  status text NOT NULL DEFAULT 'draft',
  idempotency_key text,
  description text,
  claim_id uuid,
  check_id uuid,
  source_kind text NOT NULL DEFAULT 'bank',
  source_payment_method_id uuid,
  source_wallet_id uuid,
  total_amount_cents bigint NOT NULL DEFAULT 0,
  facilitator_fee_cents bigint NOT NULL DEFAULT 0,
  net_amount_cents bigint NOT NULL DEFAULT 0,
  leg_count integer NOT NULL DEFAULT 0,
  failure_reason text,
  provider_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  submitted_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX payment_transfer_groups_idem_uidx
  ON public.payment_transfer_groups (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX payment_transfer_groups_tenant_idx ON public.payment_transfer_groups (tenant_id, created_at DESC);
CREATE INDEX payment_transfer_groups_check_idx ON public.payment_transfer_groups (check_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.payment_transfer_groups TO authenticated;
GRANT ALL ON public.payment_transfer_groups TO service_role;
ALTER TABLE public.payment_transfer_groups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members read transfer groups" ON public.payment_transfer_groups
  FOR SELECT TO authenticated
  USING (public.is_tenant_member(auth.uid(), tenant_id) OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Managers write transfer groups" ON public.payment_transfer_groups
  FOR ALL TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR EXISTS (SELECT 1 FROM public.tenant_users tu
               WHERE tu.user_id = auth.uid() AND tu.tenant_id = payment_transfer_groups.tenant_id
                 AND tu.role::text IN ('owner','admin','manager'))
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'admin')
    OR EXISTS (SELECT 1 FROM public.tenant_users tu
               WHERE tu.user_id = auth.uid() AND tu.tenant_id = payment_transfer_groups.tenant_id
                 AND tu.role::text IN ('owner','admin','manager'))
  );

-- Legs on the existing transfers table
ALTER TABLE public.payment_transfers
  ADD COLUMN IF NOT EXISTS transfer_group_id uuid REFERENCES public.payment_transfer_groups(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS leg_role text,
  ADD COLUMN IF NOT EXISTS is_facilitator_fee boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS wallet_id uuid;
CREATE INDEX IF NOT EXISTS payment_transfers_group_idx ON public.payment_transfers (transfer_group_id);

-- ============ 2. Wallets ============
CREATE TABLE public.payment_wallets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  provider text NOT NULL DEFAULT 'moov',
  environment text NOT NULL DEFAULT 'sandbox',
  provider_wallet_id text,
  provider_account_id text,
  provider_payment_method_id text,
  wallet_type text NOT NULL DEFAULT 'operating',
  name text NOT NULL DEFAULT 'Operating wallet',
  currency text NOT NULL DEFAULT 'USD',
  available_cents bigint NOT NULL DEFAULT 0,
  pending_cents bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active',
  last_synced_at timestamptz,
  provider_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_wallets_type_chk CHECK (wallet_type IN ('operating','trust')),
  CONSTRAINT payment_wallets_available_nonneg CHECK (available_cents >= 0)
);
CREATE UNIQUE INDEX payment_wallets_unique_idx
  ON public.payment_wallets (tenant_id, provider, environment, wallet_type);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.payment_wallets TO authenticated;
GRANT ALL ON public.payment_wallets TO service_role;
ALTER TABLE public.payment_wallets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members read wallets" ON public.payment_wallets
  FOR SELECT TO authenticated
  USING (public.is_tenant_member(auth.uid(), tenant_id) OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Managers write wallets" ON public.payment_wallets
  FOR ALL TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR EXISTS (SELECT 1 FROM public.tenant_users tu
               WHERE tu.user_id = auth.uid() AND tu.tenant_id = payment_wallets.tenant_id
                 AND tu.role::text IN ('owner','admin','manager'))
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'admin')
    OR EXISTS (SELECT 1 FROM public.tenant_users tu
               WHERE tu.user_id = auth.uid() AND tu.tenant_id = payment_wallets.tenant_id
                 AND tu.role::text IN ('owner','admin','manager'))
  );

-- Trust sub-ledgers (per matter / claim)
CREATE TABLE public.payment_wallet_sub_ledgers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id uuid NOT NULL REFERENCES public.payment_wallets(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL,
  claim_id uuid,
  matter_reference text,
  client_name text NOT NULL,
  balance_cents bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'open',
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wallet_sub_ledger_nonneg CHECK (balance_cents >= 0)
);
CREATE INDEX payment_wallet_sub_ledgers_wallet_idx ON public.payment_wallet_sub_ledgers (wallet_id);
CREATE UNIQUE INDEX payment_wallet_sub_ledgers_claim_uidx
  ON public.payment_wallet_sub_ledgers (wallet_id, claim_id) WHERE claim_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.payment_wallet_sub_ledgers TO authenticated;
GRANT ALL ON public.payment_wallet_sub_ledgers TO service_role;
ALTER TABLE public.payment_wallet_sub_ledgers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members read sub ledgers" ON public.payment_wallet_sub_ledgers
  FOR SELECT TO authenticated
  USING (public.is_tenant_member(auth.uid(), tenant_id) OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Managers write sub ledgers" ON public.payment_wallet_sub_ledgers
  FOR ALL TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR EXISTS (SELECT 1 FROM public.tenant_users tu
               WHERE tu.user_id = auth.uid() AND tu.tenant_id = payment_wallet_sub_ledgers.tenant_id
                 AND tu.role::text IN ('owner','admin','manager'))
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'admin')
    OR EXISTS (SELECT 1 FROM public.tenant_users tu
               WHERE tu.user_id = auth.uid() AND tu.tenant_id = payment_wallet_sub_ledgers.tenant_id
                 AND tu.role::text IN ('owner','admin','manager'))
  );

-- Immutable ledger
CREATE TABLE public.payment_wallet_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id uuid NOT NULL REFERENCES public.payment_wallets(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL,
  sub_ledger_id uuid REFERENCES public.payment_wallet_sub_ledgers(id) ON DELETE SET NULL,
  direction text NOT NULL,
  entry_type text NOT NULL,
  amount_cents bigint NOT NULL,
  balance_after_cents bigint NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'USD',
  transfer_id uuid,
  transfer_group_id uuid,
  claim_id uuid,
  check_id uuid,
  provider_transfer_id text,
  reference text,
  memo text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wallet_ledger_direction_chk CHECK (direction IN ('credit','debit')),
  CONSTRAINT wallet_ledger_amount_chk CHECK (amount_cents > 0)
);
CREATE INDEX payment_wallet_ledger_wallet_idx ON public.payment_wallet_ledger (wallet_id, created_at DESC);
CREATE INDEX payment_wallet_ledger_sub_idx ON public.payment_wallet_ledger (sub_ledger_id);
CREATE UNIQUE INDEX payment_wallet_ledger_ref_uidx
  ON public.payment_wallet_ledger (wallet_id, reference) WHERE reference IS NOT NULL;

GRANT SELECT ON public.payment_wallet_ledger TO authenticated;
GRANT ALL ON public.payment_wallet_ledger TO service_role;
ALTER TABLE public.payment_wallet_ledger ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members read wallet ledger" ON public.payment_wallet_ledger
  FOR SELECT TO authenticated
  USING (public.is_tenant_member(auth.uid(), tenant_id) OR public.has_role(auth.uid(), 'admin'));

-- Balance maintenance: ledger entries drive wallet + sub-ledger balances.
CREATE OR REPLACE FUNCTION public.apply_wallet_ledger_entry()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_delta bigint;
  v_balance bigint;
BEGIN
  v_delta := CASE WHEN NEW.direction = 'credit' THEN NEW.amount_cents ELSE -NEW.amount_cents END;

  UPDATE public.payment_wallets
     SET available_cents = available_cents + v_delta,
         updated_at = now()
   WHERE id = NEW.wallet_id
   RETURNING available_cents INTO v_balance;

  IF v_balance IS NULL THEN
    RAISE EXCEPTION 'Wallet % not found', NEW.wallet_id;
  END IF;

  NEW.balance_after_cents := v_balance;

  IF NEW.sub_ledger_id IS NOT NULL THEN
    UPDATE public.payment_wallet_sub_ledgers
       SET balance_cents = balance_cents + v_delta,
           updated_at = now()
     WHERE id = NEW.sub_ledger_id;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_apply_wallet_ledger_entry
  BEFORE INSERT ON public.payment_wallet_ledger
  FOR EACH ROW EXECUTE FUNCTION public.apply_wallet_ledger_entry();

-- Ledger rows are append-only.
CREATE OR REPLACE FUNCTION public.block_wallet_ledger_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'Wallet ledger entries are immutable';
END;
$$;
CREATE TRIGGER trg_block_wallet_ledger_mutation
  BEFORE UPDATE OR DELETE ON public.payment_wallet_ledger
  FOR EACH ROW EXECUTE FUNCTION public.block_wallet_ledger_mutation();

-- ============ 3. Bank verification (micro-deposit / instant) ============
CREATE TABLE public.payment_method_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  payment_method_id uuid REFERENCES public.payment_provider_methods(id) ON DELETE CASCADE,
  external_recipient_id uuid,
  provider text NOT NULL DEFAULT 'moov',
  environment text NOT NULL DEFAULT 'sandbox',
  provider_account_id text,
  provider_bank_account_id text,
  method text NOT NULL DEFAULT 'micro_deposit',
  status text NOT NULL DEFAULT 'initiated',
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  failure_reason text,
  initiated_by uuid,
  initiated_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  provider_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_method_verifications_method_chk CHECK (method IN ('micro_deposit','instant')),
  CONSTRAINT payment_method_verifications_status_chk
    CHECK (status IN ('initiated','pending','verified','failed','max_attempts_exceeded'))
);
CREATE INDEX payment_method_verifications_tenant_idx ON public.payment_method_verifications (tenant_id);
CREATE INDEX payment_method_verifications_method_idx ON public.payment_method_verifications (payment_method_id);

GRANT SELECT, INSERT, UPDATE ON public.payment_method_verifications TO authenticated;
GRANT ALL ON public.payment_method_verifications TO service_role;
ALTER TABLE public.payment_method_verifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members read verifications" ON public.payment_method_verifications
  FOR SELECT TO authenticated
  USING (public.is_tenant_member(auth.uid(), tenant_id) OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Managers write verifications" ON public.payment_method_verifications
  FOR ALL TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR EXISTS (SELECT 1 FROM public.tenant_users tu
               WHERE tu.user_id = auth.uid() AND tu.tenant_id = payment_method_verifications.tenant_id
                 AND tu.role::text IN ('owner','admin','manager'))
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'admin')
    OR EXISTS (SELECT 1 FROM public.tenant_users tu
               WHERE tu.user_id = auth.uid() AND tu.tenant_id = payment_method_verifications.tenant_id
                 AND tu.role::text IN ('owner','admin','manager'))
  );

-- ============ 4. updated_at triggers ============
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

CREATE TRIGGER trg_ptg_updated BEFORE UPDATE ON public.payment_transfer_groups
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_pw_updated BEFORE UPDATE ON public.payment_wallets
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_pwsl_updated BEFORE UPDATE ON public.payment_wallet_sub_ledgers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_pmv_updated BEFORE UPDATE ON public.payment_method_verifications
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();