-- Staging-only provider sandbox isolation tables.
-- Never write sandbox IDs into payment_provider_accounts, payment_wallets,
-- payment_transfers, checkalt_deposits, or other production financial tables.
-- Does not GRANT DML on production money ledgers.
-- Does not change default_transaction_read_only.

CREATE TABLE IF NOT EXISTS public.aws_provider_sandbox_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  provider text NOT NULL,
  object_type text NOT NULL,
  sandbox_provider_id text NOT NULL,
  environment text NOT NULL DEFAULT 'sandbox',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT aws_provider_sandbox_objects_env CHECK (environment = 'sandbox'),
  UNIQUE (tenant_id, provider, object_type, sandbox_provider_id)
);

CREATE INDEX IF NOT EXISTS aws_provider_sandbox_objects_tenant_idx
  ON public.aws_provider_sandbox_objects (tenant_id, provider, object_type);

COMMENT ON TABLE public.aws_provider_sandbox_objects IS
  'Sandbox-only provider object IDs. Isolated from production Moov/CheckAlt account identifiers.';

CREATE TABLE IF NOT EXISTS public.aws_provider_sandbox_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  application_user_id uuid NOT NULL,
  operation_type text NOT NULL,
  provider text NOT NULL,
  amount_cents bigint NOT NULL,
  currency text NOT NULL DEFAULT 'USD',
  idempotency_key text NOT NULL,
  status text NOT NULL,
  previous_status text,
  provider_reference text,
  sandbox_http_called boolean NOT NULL DEFAULT false,
  production_execution boolean NOT NULL DEFAULT false,
  failure_class text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT aws_provider_sandbox_operations_amount_positive CHECK (amount_cents > 0),
  CONSTRAINT aws_provider_sandbox_operations_no_production CHECK (production_execution = false),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS aws_provider_sandbox_operations_tenant_idx
  ON public.aws_provider_sandbox_operations (tenant_id, created_at DESC);

COMMENT ON TABLE public.aws_provider_sandbox_operations IS
  'Sandbox provider validation operations. Must never mutate production financial ledgers.';

CREATE TABLE IF NOT EXISTS public.aws_provider_sandbox_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_user_id uuid,
  tenant_id uuid,
  operation_type text,
  operation_id uuid,
  provider text,
  provider_reference text,
  outcome text NOT NULL,
  idempotency_key text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS aws_provider_sandbox_audit_tenant_idx
  ON public.aws_provider_sandbox_audit (tenant_id, created_at DESC);

COMMENT ON TABLE public.aws_provider_sandbox_audit IS
  'Sandbox provider validation audit. No secrets or full account numbers.';

CREATE TABLE IF NOT EXISTS public.aws_provider_sandbox_webhooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  external_event_id text NOT NULL,
  mapped_tenant_id uuid,
  signature_ok boolean NOT NULL DEFAULT false,
  duplicate boolean NOT NULL DEFAULT false,
  applied boolean NOT NULL DEFAULT false,
  mutates_production boolean NOT NULL DEFAULT false,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT aws_provider_sandbox_webhooks_no_prod CHECK (mutates_production = false),
  UNIQUE (provider, external_event_id)
);

CREATE INDEX IF NOT EXISTS aws_provider_sandbox_webhooks_tenant_idx
  ON public.aws_provider_sandbox_webhooks (mapped_tenant_id, created_at DESC);

COMMENT ON TABLE public.aws_provider_sandbox_webhooks IS
  'Staging/sandbox webhook receipts only. Must not mutate production financial records.';

ALTER TABLE public.aws_provider_sandbox_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aws_provider_sandbox_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aws_provider_sandbox_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aws_provider_sandbox_webhooks ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.aws_provider_sandbox_objects FROM PUBLIC;
REVOKE ALL ON TABLE public.aws_provider_sandbox_operations FROM PUBLIC;
REVOKE ALL ON TABLE public.aws_provider_sandbox_audit FROM PUBLIC;
REVOKE ALL ON TABLE public.aws_provider_sandbox_webhooks FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.aws_provider_sandbox_objects TO checksops;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.aws_provider_sandbox_operations TO checksops;
GRANT SELECT, INSERT ON TABLE public.aws_provider_sandbox_audit TO checksops;
GRANT SELECT, INSERT, UPDATE ON TABLE public.aws_provider_sandbox_webhooks TO checksops;

DROP POLICY IF EXISTS aws_provider_sandbox_objects_all ON public.aws_provider_sandbox_objects;
CREATE POLICY aws_provider_sandbox_objects_all
  ON public.aws_provider_sandbox_objects
  FOR ALL
  TO checksops
  USING (current_setting('request.provider_sandbox', true) = '1')
  WITH CHECK (current_setting('request.provider_sandbox', true) = '1');

DROP POLICY IF EXISTS aws_provider_sandbox_operations_all ON public.aws_provider_sandbox_operations;
CREATE POLICY aws_provider_sandbox_operations_all
  ON public.aws_provider_sandbox_operations
  FOR ALL
  TO checksops
  USING (current_setting('request.provider_sandbox', true) = '1')
  WITH CHECK (current_setting('request.provider_sandbox', true) = '1');

DROP POLICY IF EXISTS aws_provider_sandbox_audit_all ON public.aws_provider_sandbox_audit;
CREATE POLICY aws_provider_sandbox_audit_all
  ON public.aws_provider_sandbox_audit
  FOR ALL
  TO checksops
  USING (current_setting('request.provider_sandbox', true) = '1')
  WITH CHECK (current_setting('request.provider_sandbox', true) = '1');

DROP POLICY IF EXISTS aws_provider_sandbox_webhooks_all ON public.aws_provider_sandbox_webhooks;
CREATE POLICY aws_provider_sandbox_webhooks_all
  ON public.aws_provider_sandbox_webhooks
  FOR ALL
  TO checksops
  USING (current_setting('request.provider_sandbox', true) = '1')
  WITH CHECK (current_setting('request.provider_sandbox', true) = '1');
