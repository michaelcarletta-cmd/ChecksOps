CREATE TABLE public.claim_project_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  claim_id uuid,
  case_id uuid,
  start_window_start date,
  start_window_end date,
  schedule_status text NOT NULL DEFAULT 'tentative',
  schedule_note text,
  contract_total numeric(14,2),
  deductible_amount numeric(14,2),
  other_out_of_pocket numeric(14,2),
  share_with_homeowner boolean NOT NULL DEFAULT true,
  allow_deductible_payment boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT claim_project_plans_status_check CHECK (schedule_status IN ('tentative','confirmed','rescheduled','in_progress','complete','on_hold')),
  CONSTRAINT claim_project_plans_scope_check CHECK (claim_id IS NOT NULL OR case_id IS NOT NULL)
);

CREATE UNIQUE INDEX claim_project_plans_claim_uniq ON public.claim_project_plans (claim_id) WHERE claim_id IS NOT NULL;
CREATE UNIQUE INDEX claim_project_plans_case_uniq ON public.claim_project_plans (case_id) WHERE claim_id IS NULL AND case_id IS NOT NULL;
CREATE INDEX claim_project_plans_tenant_idx ON public.claim_project_plans (tenant_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.claim_project_plans TO authenticated;
GRANT ALL ON public.claim_project_plans TO service_role;

ALTER TABLE public.claim_project_plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Tenant members manage project plans"
ON public.claim_project_plans FOR ALL TO authenticated
USING (tenant_id IN (SELECT tenant_users.tenant_id FROM public.tenant_users WHERE tenant_users.user_id = auth.uid()))
WITH CHECK (tenant_id IN (SELECT tenant_users.tenant_id FROM public.tenant_users WHERE tenant_users.user_id = auth.uid()));

CREATE TRIGGER set_claim_project_plans_updated_at
BEFORE UPDATE ON public.claim_project_plans
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.homeowner_deductible_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  claim_id uuid,
  case_id uuid,
  token_id uuid REFERENCES public.homeowner_ledger_tokens(id) ON DELETE SET NULL,
  recipient_id uuid REFERENCES public.external_payment_recipients(id) ON DELETE SET NULL,
  payment_transfer_id uuid,
  amount numeric(14,2) NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  environment text NOT NULL DEFAULT 'production',
  provider text NOT NULL DEFAULT 'moov',
  provider_transfer_id text,
  provider_status text,
  idempotency_key text NOT NULL,
  bank_name text,
  bank_last_four text,
  authorization_accepted_at timestamptz,
  authorization_text text,
  payer_name text,
  payer_email text,
  failure_reason text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT homeowner_deductible_payments_amount_check CHECK (amount > 0),
  CONSTRAINT homeowner_deductible_payments_status_check CHECK (status IN ('draft','authorization_required','initiating','pending','processing','completed','failed','returned','canceled'))
);

CREATE UNIQUE INDEX homeowner_deductible_payments_idem_uniq ON public.homeowner_deductible_payments (idempotency_key);
CREATE INDEX homeowner_deductible_payments_tenant_idx ON public.homeowner_deductible_payments (tenant_id);
CREATE INDEX homeowner_deductible_payments_claim_idx ON public.homeowner_deductible_payments (claim_id);
CREATE INDEX homeowner_deductible_payments_transfer_idx ON public.homeowner_deductible_payments (provider_transfer_id);
CREATE INDEX homeowner_deductible_payments_status_idx ON public.homeowner_deductible_payments (status);

GRANT SELECT ON public.homeowner_deductible_payments TO authenticated;
GRANT ALL ON public.homeowner_deductible_payments TO service_role;

ALTER TABLE public.homeowner_deductible_payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Tenant members view deductible payments"
ON public.homeowner_deductible_payments FOR SELECT TO authenticated
USING (tenant_id IN (SELECT tenant_users.tenant_id FROM public.tenant_users WHERE tenant_users.user_id = auth.uid()));

CREATE TRIGGER set_homeowner_deductible_payments_updated_at
BEFORE UPDATE ON public.homeowner_deductible_payments
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();