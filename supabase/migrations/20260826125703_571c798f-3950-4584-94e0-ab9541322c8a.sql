CREATE TABLE public.check_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  external_system text NOT NULL DEFAULT 'freedom_crm',
  external_claim_id uuid,
  external_reference text,
  claim_number text,
  insured_name text,
  insured_email text,
  insured_phone text,
  property_address text,
  carrier_name text,
  policy_number text,
  mortgage_company_id uuid,
  loan_number text,
  loss_date date,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX check_cases_external_claim_uidx
  ON public.check_cases (external_system, external_claim_id)
  WHERE external_claim_id IS NOT NULL;
CREATE INDEX check_cases_tenant_idx ON public.check_cases (tenant_id);
CREATE INDEX check_cases_claim_number_idx ON public.check_cases (claim_number);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.check_cases TO authenticated;
GRANT ALL ON public.check_cases TO service_role;

ALTER TABLE public.check_cases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owner tenant staff can view check cases"
  ON public.check_cases FOR SELECT TO authenticated
  USING ((public.has_role(auth.uid(), 'admin'::app_role) OR public.has_role(auth.uid(), 'staff'::app_role))
         AND public.user_belongs_to_tenant(auth.uid(), tenant_id));

CREATE POLICY "Owner tenant staff can insert check cases"
  ON public.check_cases FOR INSERT TO authenticated
  WITH CHECK ((public.has_role(auth.uid(), 'admin'::app_role) OR public.has_role(auth.uid(), 'staff'::app_role))
         AND public.user_belongs_to_tenant(auth.uid(), tenant_id));

CREATE POLICY "Owner tenant staff can update check cases"
  ON public.check_cases FOR UPDATE TO authenticated
  USING ((public.has_role(auth.uid(), 'admin'::app_role) OR public.has_role(auth.uid(), 'staff'::app_role))
         AND public.user_belongs_to_tenant(auth.uid(), tenant_id))
  WITH CHECK ((public.has_role(auth.uid(), 'admin'::app_role) OR public.has_role(auth.uid(), 'staff'::app_role))
         AND public.user_belongs_to_tenant(auth.uid(), tenant_id));

CREATE POLICY "Owner tenant staff can delete check cases"
  ON public.check_cases FOR DELETE TO authenticated
  USING ((public.has_role(auth.uid(), 'admin'::app_role) OR public.has_role(auth.uid(), 'staff'::app_role))
         AND public.user_belongs_to_tenant(auth.uid(), tenant_id));

CREATE POLICY "Read-only can view check cases"
  ON public.check_cases FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'read_only'::app_role) AND public.is_tenant_member(auth.uid(), tenant_id));

CREATE TRIGGER set_check_cases_updated_at
  BEFORE UPDATE ON public.check_cases
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Transitional case_id columns (claim_id preserved everywhere)
ALTER TABLE public.check_intake_items          ADD COLUMN case_id uuid REFERENCES public.check_cases(id) ON DELETE SET NULL;
ALTER TABLE public.loss_draft_tracking         ADD COLUMN case_id uuid REFERENCES public.check_cases(id) ON DELETE SET NULL;
ALTER TABLE public.mortgage_releases           ADD COLUMN case_id uuid REFERENCES public.check_cases(id) ON DELETE SET NULL;
ALTER TABLE public.claim_check_mortgage_draws  ADD COLUMN case_id uuid REFERENCES public.check_cases(id) ON DELETE SET NULL;
ALTER TABLE public.homeowner_ledger_tokens     ADD COLUMN case_id uuid REFERENCES public.check_cases(id) ON DELETE SET NULL;
ALTER TABLE public.homeowner_ledger_events     ADD COLUMN case_id uuid REFERENCES public.check_cases(id) ON DELETE SET NULL;
ALTER TABLE public.homeowner_ledger_check_uploads ADD COLUMN case_id uuid REFERENCES public.check_cases(id) ON DELETE SET NULL;
ALTER TABLE public.signature_requests          ADD COLUMN case_id uuid REFERENCES public.check_cases(id) ON DELETE SET NULL;
ALTER TABLE public.claim_checks                ADD COLUMN case_id uuid REFERENCES public.check_cases(id) ON DELETE SET NULL;

CREATE INDEX check_intake_items_case_idx ON public.check_intake_items (case_id);
CREATE INDEX loss_draft_tracking_case_idx ON public.loss_draft_tracking (case_id);
CREATE INDEX homeowner_ledger_events_case_idx ON public.homeowner_ledger_events (case_id);

-- Backfill: one case per claim referenced by a money/document flow
WITH refs AS (
  SELECT claim_id, tenant_id FROM public.check_intake_items WHERE claim_id IS NOT NULL
  UNION ALL SELECT claim_id, tenant_id FROM public.homeowner_ledger_tokens WHERE claim_id IS NOT NULL
  UNION ALL SELECT claim_id, tenant_id FROM public.homeowner_ledger_events WHERE claim_id IS NOT NULL
  UNION ALL SELECT claim_id, tenant_id FROM public.homeowner_ledger_check_uploads WHERE claim_id IS NOT NULL
  UNION ALL SELECT ldt.claim_id, ci.tenant_id FROM public.loss_draft_tracking ldt
       LEFT JOIN public.check_intake_items ci ON ci.id = ldt.check_intake_item_id
       WHERE ldt.claim_id IS NOT NULL
  UNION ALL SELECT claim_id, NULL::uuid FROM public.mortgage_releases WHERE claim_id IS NOT NULL
  UNION ALL SELECT claim_id, NULL::uuid FROM public.claim_check_mortgage_draws WHERE claim_id IS NOT NULL
  UNION ALL SELECT claim_id, NULL::uuid FROM public.claim_checks WHERE claim_id IS NOT NULL
  UNION ALL SELECT claim_id, NULL::uuid FROM public.signature_requests WHERE claim_id IS NOT NULL
), resolved AS (
  SELECT claim_id, (array_agg(tenant_id) FILTER (WHERE tenant_id IS NOT NULL))[1] AS tenant_id
  FROM refs GROUP BY claim_id
)
INSERT INTO public.check_cases (
  tenant_id, external_system, external_claim_id, claim_number, insured_name,
  insured_email, insured_phone, property_address, carrier_name, policy_number,
  mortgage_company_id, loan_number, loss_date, status
)
SELECT
  r.tenant_id, 'freedom_crm', c.id, c.claim_number, c.policyholder_name,
  c.policyholder_email, c.policyholder_phone, c.policyholder_address,
  c.insurance_company, c.policy_number, c.mortgage_company_id, c.loan_number,
  c.loss_date, COALESCE(c.status, 'active')
FROM resolved r
JOIN public.claims c ON c.id = r.claim_id
WHERE r.tenant_id IS NOT NULL
ON CONFLICT DO NOTHING;

UPDATE public.check_intake_items t SET case_id = cc.id
  FROM public.check_cases cc WHERE cc.external_claim_id = t.claim_id AND t.claim_id IS NOT NULL;
UPDATE public.loss_draft_tracking t SET case_id = cc.id
  FROM public.check_cases cc WHERE cc.external_claim_id = t.claim_id AND t.claim_id IS NOT NULL;
UPDATE public.mortgage_releases t SET case_id = cc.id
  FROM public.check_cases cc WHERE cc.external_claim_id = t.claim_id AND t.claim_id IS NOT NULL;
UPDATE public.claim_check_mortgage_draws t SET case_id = cc.id
  FROM public.check_cases cc WHERE cc.external_claim_id = t.claim_id AND t.claim_id IS NOT NULL;
UPDATE public.homeowner_ledger_tokens t SET case_id = cc.id
  FROM public.check_cases cc WHERE cc.external_claim_id = t.claim_id AND t.claim_id IS NOT NULL;
UPDATE public.homeowner_ledger_events t SET case_id = cc.id
  FROM public.check_cases cc WHERE cc.external_claim_id = t.claim_id AND t.claim_id IS NOT NULL;
UPDATE public.homeowner_ledger_check_uploads t SET case_id = cc.id
  FROM public.check_cases cc WHERE cc.external_claim_id = t.claim_id AND t.claim_id IS NOT NULL;
UPDATE public.signature_requests t SET case_id = cc.id
  FROM public.check_cases cc WHERE cc.external_claim_id = t.claim_id AND t.claim_id IS NOT NULL;
UPDATE public.claim_checks t SET case_id = cc.id
  FROM public.check_cases cc WHERE cc.external_claim_id = t.claim_id AND t.claim_id IS NOT NULL;