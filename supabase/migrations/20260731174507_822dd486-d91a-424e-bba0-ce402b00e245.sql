-- =========================================================
-- PART 1: RLS hardening — scope claim intelligence to claim access
-- =========================================================

-- ai_generated_tasks
DROP POLICY IF EXISTS "Authenticated users can manage AI generated tasks" ON public.ai_generated_tasks;
CREATE POLICY "Claim members can manage AI generated tasks"
ON public.ai_generated_tasks FOR ALL TO authenticated
USING (public.user_can_access_claim(auth.uid(), claim_id))
WITH CHECK (public.user_can_access_claim(auth.uid(), claim_id));

-- carrier_behavior_analytics (shared platform data: read all, write staff/admin)
DROP POLICY IF EXISTS "Authenticated users can insert carrier analytics" ON public.carrier_behavior_analytics;
DROP POLICY IF EXISTS "Authenticated users can update carrier analytics" ON public.carrier_behavior_analytics;
CREATE POLICY "Staff can insert carrier analytics"
ON public.carrier_behavior_analytics FOR INSERT TO authenticated
WITH CHECK (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff'));
CREATE POLICY "Staff can update carrier analytics"
ON public.carrier_behavior_analytics FOR UPDATE TO authenticated
USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff'))
WITH CHECK (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff'));

-- claim_causation_tests
DROP POLICY IF EXISTS "Authenticated users can create causation tests" ON public.claim_causation_tests;
DROP POLICY IF EXISTS "Authenticated users can delete causation tests" ON public.claim_causation_tests;
DROP POLICY IF EXISTS "Authenticated users can update causation tests" ON public.claim_causation_tests;
DROP POLICY IF EXISTS "Authenticated users can view causation tests" ON public.claim_causation_tests;
CREATE POLICY "Claim members can manage causation tests"
ON public.claim_causation_tests FOR ALL TO authenticated
USING (public.user_can_access_claim(auth.uid(), claim_id))
WITH CHECK (public.user_can_access_claim(auth.uid(), claim_id));

-- claim_outcome_events
DROP POLICY IF EXISTS "Authenticated users can read claim outcomes" ON public.claim_outcome_events;
CREATE POLICY "Claim members can read claim outcome events"
ON public.claim_outcome_events FOR SELECT TO authenticated
USING (public.user_can_access_claim(auth.uid(), claim_id));

-- claim_outcome_predictions
DROP POLICY IF EXISTS "Authenticated users can manage outcome predictions" ON public.claim_outcome_predictions;
CREATE POLICY "Claim members can manage outcome predictions"
ON public.claim_outcome_predictions FOR ALL TO authenticated
USING (public.user_can_access_claim(auth.uid(), claim_id))
WITH CHECK (public.user_can_access_claim(auth.uid(), claim_id));

-- claim_outcomes
DROP POLICY IF EXISTS "Authenticated users can manage claim outcomes" ON public.claim_outcomes;
CREATE POLICY "Claim members can manage claim outcomes"
ON public.claim_outcomes FOR ALL TO authenticated
USING (public.user_can_access_claim(auth.uid(), claim_id))
WITH CHECK (public.user_can_access_claim(auth.uid(), claim_id));

-- claim_predictive_analysis
DROP POLICY IF EXISTS "Authenticated users can delete predictive analysis" ON public.claim_predictive_analysis;
DROP POLICY IF EXISTS "Authenticated users can insert predictive analysis" ON public.claim_predictive_analysis;
DROP POLICY IF EXISTS "Authenticated users can update predictive analysis" ON public.claim_predictive_analysis;
DROP POLICY IF EXISTS "Authenticated users can view predictive analysis" ON public.claim_predictive_analysis;
CREATE POLICY "Claim members can manage predictive analysis"
ON public.claim_predictive_analysis FOR ALL TO authenticated
USING (public.user_can_access_claim(auth.uid(), claim_id))
WITH CHECK (public.user_can_access_claim(auth.uid(), claim_id));

-- claim_scenario_simulations
DROP POLICY IF EXISTS "Authenticated users can delete scenario simulations" ON public.claim_scenario_simulations;
DROP POLICY IF EXISTS "Authenticated users can insert scenario simulations" ON public.claim_scenario_simulations;
DROP POLICY IF EXISTS "Authenticated users can update scenario simulations" ON public.claim_scenario_simulations;
DROP POLICY IF EXISTS "Authenticated users can view scenario simulations" ON public.claim_scenario_simulations;
CREATE POLICY "Claim members can manage scenario simulations"
ON public.claim_scenario_simulations FOR ALL TO authenticated
USING (public.user_can_access_claim(auth.uid(), claim_id))
WITH CHECK (public.user_can_access_claim(auth.uid(), claim_id));

-- claim_thesis_objects
DROP POLICY IF EXISTS "Authenticated users can delete thesis objects" ON public.claim_thesis_objects;
DROP POLICY IF EXISTS "Authenticated users can insert thesis objects" ON public.claim_thesis_objects;
DROP POLICY IF EXISTS "Authenticated users can update thesis objects" ON public.claim_thesis_objects;
DROP POLICY IF EXISTS "Users can view thesis objects" ON public.claim_thesis_objects;
CREATE POLICY "Claim members can manage thesis objects"
ON public.claim_thesis_objects FOR ALL TO authenticated
USING (public.user_can_access_claim(auth.uid(), claim_id))
WITH CHECK (public.user_can_access_claim(auth.uid(), claim_id));

-- claim_warnings_log
DROP POLICY IF EXISTS "Authenticated users can manage warnings log" ON public.claim_warnings_log;
CREATE POLICY "Claim members can manage warnings log"
ON public.claim_warnings_log FOR ALL TO authenticated
USING (public.user_can_access_claim(auth.uid(), claim_id))
WITH CHECK (public.user_can_access_claim(auth.uid(), claim_id));

-- darwin_declared_positions
DROP POLICY IF EXISTS "Authenticated users can create positions" ON public.darwin_declared_positions;
DROP POLICY IF EXISTS "Authenticated users can delete positions" ON public.darwin_declared_positions;
DROP POLICY IF EXISTS "Authenticated users can update positions" ON public.darwin_declared_positions;
DROP POLICY IF EXISTS "Authenticated users can view positions" ON public.darwin_declared_positions;
CREATE POLICY "Claim members can manage declared positions"
ON public.darwin_declared_positions FOR ALL TO authenticated
USING (public.user_can_access_claim(auth.uid(), claim_id))
WITH CHECK (public.user_can_access_claim(auth.uid(), claim_id));

-- darwin_declared_position_audit_logs
DROP POLICY IF EXISTS "Authenticated users can insert audit logs" ON public.darwin_declared_position_audit_logs;
DROP POLICY IF EXISTS "Authenticated users can read audit logs" ON public.darwin_declared_position_audit_logs;
CREATE POLICY "Claim members can read declared position audit logs"
ON public.darwin_declared_position_audit_logs FOR SELECT TO authenticated
USING (public.user_can_access_claim(auth.uid(), claim_id));
CREATE POLICY "Claim members can insert declared position audit logs"
ON public.darwin_declared_position_audit_logs FOR INSERT TO authenticated
WITH CHECK (public.user_can_access_claim(auth.uid(), claim_id));

-- escalation_actions
DROP POLICY IF EXISTS "Users can view escalation actions" ON public.escalation_actions;
CREATE POLICY "Claim members can view escalation actions"
ON public.escalation_actions FOR SELECT TO authenticated
USING (public.user_can_access_claim(auth.uid(), claim_id));

-- global_automation_settings / workflow_automation_rules
DROP POLICY IF EXISTS "Authenticated users can view settings" ON public.global_automation_settings;
CREATE POLICY "Authenticated users can view automation settings"
ON public.global_automation_settings FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "Admins can delete automation settings" ON public.global_automation_settings;
CREATE POLICY "Admins can delete automation settings"
ON public.global_automation_settings FOR DELETE TO authenticated
USING (public.has_role(auth.uid(), 'admin'));

-- smart_follow_up_recommendations
DROP POLICY IF EXISTS "Authenticated users can manage follow-up recommendations" ON public.smart_follow_up_recommendations;
CREATE POLICY "Claim members can manage follow-up recommendations"
ON public.smart_follow_up_recommendations FOR ALL TO authenticated
USING (public.user_can_access_claim(auth.uid(), claim_id))
WITH CHECK (public.user_can_access_claim(auth.uid(), claim_id));

-- =========================================================
-- PART 2: Storage policy hardening
-- =========================================================

-- endorsement-packets: path is packets/<check_id>/<file>
DROP POLICY IF EXISTS "Authenticated users can read endorsement packets" ON storage.objects;
CREATE POLICY "Check members can read endorsement packets"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'endorsement-packets'
  AND (
    public.has_role(auth.uid(), 'admin')
    OR (
      (storage.foldername(name))[2] ~ '^[0-9a-fA-F-]{36}$'
      AND public.user_can_access_check(auth.uid(), ((storage.foldername(name))[2])::uuid)
    )
  )
);

-- loss-draft-documents: path is <claim_id>/<loss_draft_id>/<doc_id>/<file>
DROP POLICY IF EXISTS "Authenticated users can view loss draft documents" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can upload loss draft documents" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can delete loss draft documents" ON storage.objects;

CREATE POLICY "Claim members can view loss draft documents"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'loss-draft-documents'
  AND (
    public.has_role(auth.uid(), 'admin')
    OR public.has_role(auth.uid(), 'mortgage_agent')
    OR (
      (storage.foldername(name))[1] ~ '^[0-9a-fA-F-]{36}$'
      AND public.user_can_access_claim(auth.uid(), ((storage.foldername(name))[1])::uuid)
    )
  )
);

CREATE POLICY "Claim members can upload loss draft documents"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'loss-draft-documents'
  AND (
    public.has_role(auth.uid(), 'admin')
    OR public.has_role(auth.uid(), 'mortgage_agent')
    OR (
      (storage.foldername(name))[1] ~ '^[0-9a-fA-F-]{36}$'
      AND public.user_can_access_claim(auth.uid(), ((storage.foldername(name))[1])::uuid)
    )
  )
);

CREATE POLICY "Claim members can update loss draft documents"
ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id = 'loss-draft-documents'
  AND (
    public.has_role(auth.uid(), 'admin')
    OR public.has_role(auth.uid(), 'mortgage_agent')
    OR (
      (storage.foldername(name))[1] ~ '^[0-9a-fA-F-]{36}$'
      AND public.user_can_access_claim(auth.uid(), ((storage.foldername(name))[1])::uuid)
    )
  )
);

CREATE POLICY "Claim members can delete loss draft documents"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'loss-draft-documents'
  AND (
    public.has_role(auth.uid(), 'admin')
    OR public.has_role(auth.uid(), 'mortgage_agent')
    OR (
      (storage.foldername(name))[1] ~ '^[0-9a-fA-F-]{36}$'
      AND public.user_can_access_claim(auth.uid(), ((storage.foldername(name))[1])::uuid)
    )
  )
);

-- =========================================================
-- PART 3: Platform fee schedules (Moov Schedules layer)
-- =========================================================

CREATE TABLE public.platform_fee_schedules (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'moov',
  environment TEXT NOT NULL DEFAULT 'sandbox',
  name TEXT NOT NULL,
  fee_code TEXT NOT NULL DEFAULT 'platform_fees',
  description TEXT,
  cadence TEXT NOT NULL DEFAULT 'monthly',
  day_of_month INTEGER NOT NULL DEFAULT 1,
  amount_cents BIGINT NOT NULL DEFAULT 0,
  amount_mode TEXT NOT NULL DEFAULT 'usage',
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'active',
  provider_schedule_id TEXT,
  provider_source_payment_method_id TEXT,
  provider_destination_payment_method_id TEXT,
  next_run_at TIMESTAMPTZ,
  last_run_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT platform_fee_schedules_cadence_chk CHECK (cadence IN ('monthly','weekly','once')),
  CONSTRAINT platform_fee_schedules_status_chk CHECK (status IN ('draft','active','paused','cancelled')),
  CONSTRAINT platform_fee_schedules_mode_chk CHECK (amount_mode IN ('usage','fixed')),
  CONSTRAINT platform_fee_schedules_dom_chk CHECK (day_of_month BETWEEN 1 AND 28)
);
CREATE UNIQUE INDEX platform_fee_schedules_unique_active
  ON public.platform_fee_schedules (tenant_id, provider, environment, fee_code)
  WHERE status <> 'cancelled';

GRANT SELECT, INSERT, UPDATE, DELETE ON public.platform_fee_schedules TO authenticated;
GRANT ALL ON public.platform_fee_schedules TO service_role;
ALTER TABLE public.platform_fee_schedules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Tenant members can view their fee schedules"
ON public.platform_fee_schedules FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'admin')
  OR EXISTS (SELECT 1 FROM public.tenant_users tu WHERE tu.tenant_id = platform_fee_schedules.tenant_id AND tu.user_id = auth.uid())
);
CREATE POLICY "Admins can manage fee schedules"
ON public.platform_fee_schedules FOR ALL TO authenticated
USING (public.has_role(auth.uid(), 'admin'))
WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE TABLE public.platform_fee_occurrences (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  schedule_id UUID NOT NULL REFERENCES public.platform_fee_schedules(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  provider_occurrence_id TEXT,
  provider_transfer_id TEXT,
  run_at TIMESTAMPTZ NOT NULL,
  period_start DATE,
  period_end DATE,
  amount_cents BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'scheduled',
  failure_reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT platform_fee_occurrences_status_chk
    CHECK (status IN ('scheduled','processing','completed','failed','cancelled','skipped'))
);
CREATE INDEX platform_fee_occurrences_schedule_idx ON public.platform_fee_occurrences (schedule_id, run_at DESC);
CREATE UNIQUE INDEX platform_fee_occurrences_provider_uidx
  ON public.platform_fee_occurrences (provider_occurrence_id)
  WHERE provider_occurrence_id IS NOT NULL;

GRANT SELECT ON public.platform_fee_occurrences TO authenticated;
GRANT ALL ON public.platform_fee_occurrences TO service_role;
ALTER TABLE public.platform_fee_occurrences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Tenant members can view their fee occurrences"
ON public.platform_fee_occurrences FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'admin')
  OR EXISTS (SELECT 1 FROM public.tenant_users tu WHERE tu.tenant_id = platform_fee_occurrences.tenant_id AND tu.user_id = auth.uid())
);

CREATE TABLE public.platform_fee_line_items (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  fee_code TEXT NOT NULL,
  description TEXT,
  quantity NUMERIC(12,2) NOT NULL DEFAULT 1,
  unit_cents BIGINT NOT NULL DEFAULT 0,
  amount_cents BIGINT NOT NULL DEFAULT 0,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  period_start DATE,
  period_end DATE,
  check_id UUID,
  claim_id UUID,
  occurrence_id UUID REFERENCES public.platform_fee_occurrences(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'unbilled',
  source_reference TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT platform_fee_line_items_status_chk CHECK (status IN ('unbilled','billed','void'))
);
CREATE INDEX platform_fee_line_items_tenant_idx ON public.platform_fee_line_items (tenant_id, status, occurred_at DESC);
CREATE UNIQUE INDEX platform_fee_line_items_source_uidx
  ON public.platform_fee_line_items (tenant_id, source_reference)
  WHERE source_reference IS NOT NULL;

GRANT SELECT ON public.platform_fee_line_items TO authenticated;
GRANT ALL ON public.platform_fee_line_items TO service_role;
ALTER TABLE public.platform_fee_line_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Tenant members can view their fee line items"
ON public.platform_fee_line_items FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'admin')
  OR EXISTS (SELECT 1 FROM public.tenant_users tu WHERE tu.tenant_id = platform_fee_line_items.tenant_id AND tu.user_id = auth.uid())
);

CREATE TRIGGER trg_platform_fee_schedules_updated_at
BEFORE UPDATE ON public.platform_fee_schedules
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_platform_fee_occurrences_updated_at
BEFORE UPDATE ON public.platform_fee_occurrences
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_platform_fee_line_items_updated_at
BEFORE UPDATE ON public.platform_fee_line_items
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();