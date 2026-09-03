-- Financial pre-activation certification tables.
-- Staging only. Does not GRANT DML on payment_transfers, checkalt_deposits,
-- disbursement_*, claim_payments, or other money ledgers.
-- Does not change default_transaction_read_only.

CREATE TABLE IF NOT EXISTS public.aws_financial_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  application_user_id uuid NOT NULL,
  operation_type text NOT NULL,
  provider text NOT NULL,
  resource_type text,
  resource_id uuid,
  amount_cents bigint NOT NULL,
  currency text NOT NULL DEFAULT 'USD',
  amount_source text NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL,
  previous_status text,
  provider_reference text,
  simulated boolean NOT NULL DEFAULT true,
  live_provider_called boolean NOT NULL DEFAULT false,
  failure_class text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT aws_financial_operations_amount_positive CHECK (amount_cents > 0),
  CONSTRAINT aws_financial_operations_live_blocked CHECK (live_provider_called = false),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS aws_financial_operations_tenant_idx
  ON public.aws_financial_operations (tenant_id, created_at DESC);

COMMENT ON TABLE public.aws_financial_operations IS
  'AWS financial pre-activation operations. Simulated only. Not a production ledger.';

CREATE TABLE IF NOT EXISTS public.aws_financial_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_user_id uuid,
  tenant_id uuid,
  operation_type text,
  operation_id uuid,
  amount_cents bigint,
  provider text,
  provider_reference text,
  outcome text NOT NULL,
  idempotency_key text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS aws_financial_audit_tenant_idx
  ON public.aws_financial_audit (tenant_id, created_at DESC);

COMMENT ON TABLE public.aws_financial_audit IS
  'Immutable server-side financial certification audit. No secrets or full account numbers.';

CREATE TABLE IF NOT EXISTS public.aws_financial_reconciliation_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid,
  tenant_id uuid,
  finding_type text NOT NULL,
  internal_status text,
  provider_status text,
  internal_amount_cents bigint,
  provider_amount_cents bigint,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  auto_corrected boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT aws_financial_findings_no_autocorrect CHECK (auto_corrected = false)
);

COMMENT ON TABLE public.aws_financial_reconciliation_findings IS
  'Report-only reconciliation findings. Auto-correct is forbidden.';

ALTER TABLE public.aws_financial_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aws_financial_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aws_financial_reconciliation_findings ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.aws_financial_operations FROM PUBLIC;
REVOKE ALL ON TABLE public.aws_financial_audit FROM PUBLIC;
REVOKE ALL ON TABLE public.aws_financial_reconciliation_findings FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.aws_financial_operations TO checksops;
GRANT SELECT, INSERT ON TABLE public.aws_financial_audit TO checksops;
GRANT SELECT, INSERT ON TABLE public.aws_financial_reconciliation_findings TO checksops;

DROP POLICY IF EXISTS aws_financial_operations_all ON public.aws_financial_operations;
CREATE POLICY aws_financial_operations_all
  ON public.aws_financial_operations
  FOR ALL
  TO checksops
  USING (current_setting('request.financial_certification', true) = '1')
  WITH CHECK (current_setting('request.financial_certification', true) = '1');

DROP POLICY IF EXISTS aws_financial_audit_insert ON public.aws_financial_audit;
CREATE POLICY aws_financial_audit_insert
  ON public.aws_financial_audit
  FOR INSERT
  TO checksops
  WITH CHECK (current_setting('request.financial_certification', true) = '1');

DROP POLICY IF EXISTS aws_financial_audit_select ON public.aws_financial_audit;
CREATE POLICY aws_financial_audit_select
  ON public.aws_financial_audit
  FOR SELECT
  TO checksops
  USING (current_setting('request.financial_certification', true) = '1');

DROP POLICY IF EXISTS aws_financial_findings_all ON public.aws_financial_reconciliation_findings;
CREATE POLICY aws_financial_findings_all
  ON public.aws_financial_reconciliation_findings
  FOR ALL
  TO checksops
  USING (current_setting('request.financial_certification', true) = '1')
  WITH CHECK (current_setting('request.financial_certification', true) = '1');
