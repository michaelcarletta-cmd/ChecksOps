-- ============================================================
-- Moov (provider-neutral) payment platform tables
-- Additive only. Actum and Plaid tables/flows are untouched.
-- ============================================================

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS moov_allowlisted boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS moov_environment text NOT NULL DEFAULT 'sandbox';

-- ---------- 1. Provider accounts ----------
CREATE TABLE IF NOT EXISTS public.payment_provider_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'moov',
  environment text NOT NULL DEFAULT 'sandbox',
  provider_account_id text,
  account_type text NOT NULL DEFAULT 'business',
  display_name text,
  onboarding_status text NOT NULL DEFAULT 'not_started',
  verification_status text NOT NULL DEFAULT 'not_started',
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  can_receive_payments boolean NOT NULL DEFAULT false,
  can_send_payments boolean NOT NULL DEFAULT false,
  can_ach_debit boolean NOT NULL DEFAULT false,
  can_ach_credit boolean NOT NULL DEFAULT false,
  requirements jsonb NOT NULL DEFAULT '[]'::jsonb,
  restricted boolean NOT NULL DEFAULT false,
  disabled boolean NOT NULL DEFAULT false,
  onboarding_url text,
  onboarding_url_expires_at timestamptz,
  last_synced_at timestamptz,
  last_webhook_event_at timestamptz,
  last_webhook_event_type text,
  provider_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider, environment)
);
CREATE UNIQUE INDEX IF NOT EXISTS payment_provider_accounts_provider_account_uniq
  ON public.payment_provider_accounts (provider, environment, provider_account_id)
  WHERE provider_account_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.payment_provider_accounts TO authenticated;
GRANT ALL ON public.payment_provider_accounts TO service_role;
ALTER TABLE public.payment_provider_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members read own tenant provider account"
  ON public.payment_provider_accounts FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.tenant_users tu
                 WHERE tu.tenant_id = payment_provider_accounts.tenant_id
                   AND tu.user_id = auth.uid()));

CREATE POLICY "Admins manage provider accounts"
  ON public.payment_provider_accounts FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- ---------- 2. External recipients ----------
CREATE TABLE IF NOT EXISTS public.external_payment_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'moov',
  environment text NOT NULL DEFAULT 'sandbox',
  display_name text NOT NULL,
  email text,
  phone text,
  recipient_type text NOT NULL DEFAULT 'individual',
  relationship text,
  provider_account_id text,
  onboarding_status text NOT NULL DEFAULT 'not_started',
  secure_token text UNIQUE,
  token_expires_at timestamptz,
  token_used_at timestamptz,
  claim_id uuid,
  check_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS external_payment_recipients_tenant_idx
  ON public.external_payment_recipients (tenant_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.external_payment_recipients TO authenticated;
GRANT ALL ON public.external_payment_recipients TO service_role;
ALTER TABLE public.external_payment_recipients ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members read own tenant recipients"
  ON public.external_payment_recipients FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.tenant_users tu
                 WHERE tu.tenant_id = external_payment_recipients.tenant_id
                   AND tu.user_id = auth.uid()));

CREATE POLICY "Members create own tenant recipients"
  ON public.external_payment_recipients FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.tenant_users tu
                      WHERE tu.tenant_id = external_payment_recipients.tenant_id
                        AND tu.user_id = auth.uid()));

CREATE POLICY "Members update own tenant recipients"
  ON public.external_payment_recipients FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.tenant_users tu
                 WHERE tu.tenant_id = external_payment_recipients.tenant_id
                   AND tu.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.tenant_users tu
                      WHERE tu.tenant_id = external_payment_recipients.tenant_id
                        AND tu.user_id = auth.uid()));

-- ---------- 3. Payment methods (safe metadata only) ----------
CREATE TABLE IF NOT EXISTS public.payment_provider_methods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES public.tenants(id) ON DELETE CASCADE,
  external_recipient_id uuid REFERENCES public.external_payment_recipients(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'moov',
  environment text NOT NULL DEFAULT 'sandbox',
  provider_account_id text NOT NULL,
  provider_bank_account_id text NOT NULL,
  provider_payment_method_id text,
  bank_name text,
  account_type text,
  last_four text,
  holder_name text,
  verification_status text NOT NULL DEFAULT 'pending',
  connection_status text NOT NULL DEFAULT 'pending',
  can_send boolean NOT NULL DEFAULT false,
  can_receive boolean NOT NULL DEFAULT false,
  is_default boolean NOT NULL DEFAULT false,
  connected_at timestamptz,
  disconnected_at timestamptz,
  provider_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_provider_methods_owner_chk
    CHECK (tenant_id IS NOT NULL OR external_recipient_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS payment_provider_methods_bank_uniq
  ON public.payment_provider_methods (provider, environment, provider_account_id, provider_bank_account_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.payment_provider_methods TO authenticated;
GRANT ALL ON public.payment_provider_methods TO service_role;
ALTER TABLE public.payment_provider_methods ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members read own tenant payment methods"
  ON public.payment_provider_methods FOR SELECT TO authenticated
  USING (
    (tenant_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.tenant_users tu
      WHERE tu.tenant_id = payment_provider_methods.tenant_id AND tu.user_id = auth.uid()))
    OR (external_recipient_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.external_payment_recipients r
      JOIN public.tenant_users tu ON tu.tenant_id = r.tenant_id
      WHERE r.id = payment_provider_methods.external_recipient_id AND tu.user_id = auth.uid()))
  );

CREATE POLICY "Admins manage payment methods"
  ON public.payment_provider_methods FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- ---------- 4. Transfers ----------
CREATE TABLE IF NOT EXISTS public.payment_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'moov',
  environment text NOT NULL DEFAULT 'sandbox',
  provider_transfer_id text,
  provider_status text,
  status text NOT NULL DEFAULT 'draft',
  idempotency_key text NOT NULL,
  amount_cents bigint NOT NULL,
  provider_fee_cents bigint,
  platform_fee_cents bigint NOT NULL DEFAULT 0,
  net_amount_cents bigint,
  currency text NOT NULL DEFAULT 'USD',
  speed text NOT NULL DEFAULT 'standard',
  description text,
  source_tenant_account_id text,
  source_payment_method_id uuid REFERENCES public.payment_provider_methods(id),
  destination_tenant_id uuid REFERENCES public.tenants(id),
  destination_recipient_id uuid REFERENCES public.external_payment_recipients(id),
  destination_payment_method_id uuid REFERENCES public.payment_provider_methods(id),
  claim_id uuid,
  check_id uuid,
  failure_reason text,
  provider_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  submitted_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_transfers_amount_positive CHECK (amount_cents > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS payment_transfers_idempotency_uniq
  ON public.payment_transfers (tenant_id, idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS payment_transfers_provider_id_uniq
  ON public.payment_transfers (provider, environment, provider_transfer_id)
  WHERE provider_transfer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS payment_transfers_tenant_idx ON public.payment_transfers (tenant_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.payment_transfers TO authenticated;
GRANT ALL ON public.payment_transfers TO service_role;
ALTER TABLE public.payment_transfers ENABLE ROW LEVEL SECURITY;

-- Payer sees its own transfers; payee tenant sees inbound transfers only.
CREATE POLICY "Members read own tenant transfers"
  ON public.payment_transfers FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.tenant_users tu
            WHERE tu.tenant_id = payment_transfers.tenant_id AND tu.user_id = auth.uid())
    OR (destination_tenant_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.tenant_users tu
        WHERE tu.tenant_id = payment_transfers.destination_tenant_id AND tu.user_id = auth.uid()))
  );

CREATE POLICY "Admins manage transfers"
  ON public.payment_transfers FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- ---------- 5. Webhook events (backend only) ----------
CREATE TABLE IF NOT EXISTS public.payment_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL DEFAULT 'moov',
  environment text NOT NULL DEFAULT 'sandbox',
  external_event_id text NOT NULL,
  event_type text NOT NULL,
  tenant_id uuid REFERENCES public.tenants(id) ON DELETE SET NULL,
  provider_account_id text,
  resource_id text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  processed_at timestamptz,
  processing_error text,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_event_id)
);
GRANT ALL ON public.payment_webhook_events TO service_role;
ALTER TABLE public.payment_webhook_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins read webhook events"
  ON public.payment_webhook_events FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
GRANT SELECT ON public.payment_webhook_events TO authenticated;

-- ---------- 6. Safe payment event log ----------
CREATE TABLE IF NOT EXISTS public.payment_event_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES public.tenants(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'moov',
  environment text NOT NULL DEFAULT 'sandbox',
  recipient_id uuid,
  transfer_id uuid REFERENCES public.payment_transfers(id) ON DELETE SET NULL,
  provider_transfer_id text,
  event_type text NOT NULL,
  previous_status text,
  new_status text,
  provider_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payment_event_log_tenant_idx ON public.payment_event_log (tenant_id, created_at DESC);

GRANT SELECT ON public.payment_event_log TO authenticated;
GRANT ALL ON public.payment_event_log TO service_role;
ALTER TABLE public.payment_event_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members read own tenant payment events"
  ON public.payment_event_log FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.tenant_users tu
                 WHERE tu.tenant_id = payment_event_log.tenant_id AND tu.user_id = auth.uid()));

-- ---------- 7. Idempotency records (backend only) ----------
CREATE TABLE IF NOT EXISTS public.payment_idempotency_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES public.tenants(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'moov',
  scope text NOT NULL,
  idempotency_key text NOT NULL,
  request_fingerprint text,
  response jsonb,
  status text NOT NULL DEFAULT 'in_progress',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, scope, idempotency_key)
);
GRANT ALL ON public.payment_idempotency_keys TO service_role;
ALTER TABLE public.payment_idempotency_keys ENABLE ROW LEVEL SECURITY;
-- No authenticated policies: backend-only table.

-- ---------- updated_at triggers ----------
CREATE TRIGGER set_payment_provider_accounts_updated_at
  BEFORE UPDATE ON public.payment_provider_accounts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER set_external_payment_recipients_updated_at
  BEFORE UPDATE ON public.external_payment_recipients
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER set_payment_provider_methods_updated_at
  BEFORE UPDATE ON public.payment_provider_methods
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER set_payment_transfers_updated_at
  BEFORE UPDATE ON public.payment_transfers
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER set_payment_idempotency_keys_updated_at
  BEFORE UPDATE ON public.payment_idempotency_keys
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
