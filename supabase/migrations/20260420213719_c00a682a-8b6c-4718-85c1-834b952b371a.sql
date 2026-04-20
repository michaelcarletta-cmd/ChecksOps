
-- ========================================================
-- 1. claim_operational_state — one row per claim
-- ========================================================
CREATE TABLE public.claim_operational_state (
  claim_id uuid PRIMARY KEY REFERENCES public.claims(id) ON DELETE CASCADE,
  lifecycle_stage text NOT NULL DEFAULT 'new',
  next_best_action text,
  next_best_action_confidence numeric DEFAULT 0,
  follow_up_status text NOT NULL DEFAULT 'on_track',
  last_activity_at timestamptz,
  days_since_last_activity integer DEFAULT 0,
  pressure_score numeric DEFAULT 0,
  priority_rank numeric DEFAULT 0,
  stale_flag boolean NOT NULL DEFAULT false,
  contradiction_flag boolean NOT NULL DEFAULT false,
  high_exposure_flag boolean NOT NULL DEFAULT false,
  immediate_task_count integer NOT NULL DEFAULT 0,
  blocking_task_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.claim_operational_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view operational state"
  ON public.claim_operational_state FOR SELECT
  TO authenticated USING (true);

CREATE POLICY "Authenticated users can insert operational state"
  ON public.claim_operational_state FOR INSERT
  TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated users can update operational state"
  ON public.claim_operational_state FOR UPDATE
  TO authenticated USING (true);

CREATE INDEX idx_claim_ops_priority ON public.claim_operational_state (priority_rank DESC);
CREATE INDEX idx_claim_ops_followup ON public.claim_operational_state (follow_up_status);
CREATE INDEX idx_claim_ops_stale ON public.claim_operational_state (stale_flag) WHERE stale_flag = true;
CREATE INDEX idx_claim_ops_exposure ON public.claim_operational_state (high_exposure_flag) WHERE high_exposure_flag = true;

-- ========================================================
-- 2. claim_microtasks — execution items within a claim
-- ========================================================
CREATE TABLE public.claim_microtasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  task_type text,
  priority text NOT NULL DEFAULT 'normal',
  status text NOT NULL DEFAULT 'pending',
  due_at timestamptz,
  is_blocking boolean NOT NULL DEFAULT false,
  surfaced_on_board boolean NOT NULL DEFAULT true,
  created_by uuid,
  assigned_to uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT valid_priority CHECK (priority IN ('low', 'normal', 'high', 'immediate')),
  CONSTRAINT valid_status CHECK (status IN ('pending', 'in_progress', 'done', 'cancelled'))
);

ALTER TABLE public.claim_microtasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view microtasks"
  ON public.claim_microtasks FOR SELECT
  TO authenticated USING (true);

CREATE POLICY "Authenticated users can create microtasks"
  ON public.claim_microtasks FOR INSERT
  TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated users can update microtasks"
  ON public.claim_microtasks FOR UPDATE
  TO authenticated USING (true);

CREATE POLICY "Authenticated users can delete microtasks"
  ON public.claim_microtasks FOR DELETE
  TO authenticated USING (true);

CREATE INDEX idx_microtasks_claim ON public.claim_microtasks (claim_id);
CREATE INDEX idx_microtasks_due ON public.claim_microtasks (due_at) WHERE status IN ('pending', 'in_progress');
CREATE INDEX idx_microtasks_immediate ON public.claim_microtasks (claim_id) WHERE priority = 'immediate' AND status IN ('pending', 'in_progress');
CREATE INDEX idx_microtasks_blocking ON public.claim_microtasks (claim_id) WHERE is_blocking = true AND status IN ('pending', 'in_progress');
CREATE INDEX idx_microtasks_status ON public.claim_microtasks (status);

-- Auto-update updated_at
CREATE TRIGGER update_claim_microtasks_updated_at
  BEFORE UPDATE ON public.claim_microtasks
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- ========================================================
-- 3. claim_followup_log — follow-up cycle tracking
-- ========================================================
CREATE TABLE public.claim_followup_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  trigger_reason text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  triggered_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  notes text,
  CONSTRAINT valid_followup_status CHECK (status IN ('active', 'resolved', 'dismissed'))
);

ALTER TABLE public.claim_followup_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view followup logs"
  ON public.claim_followup_log FOR SELECT
  TO authenticated USING (true);

CREATE POLICY "Authenticated users can create followup logs"
  ON public.claim_followup_log FOR INSERT
  TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated users can update followup logs"
  ON public.claim_followup_log FOR UPDATE
  TO authenticated USING (true);

CREATE INDEX idx_followup_claim ON public.claim_followup_log (claim_id);
CREATE INDEX idx_followup_active ON public.claim_followup_log (claim_id) WHERE status = 'active';

-- Auto-update for operational state
CREATE TRIGGER update_claim_ops_updated_at
  BEFORE UPDATE ON public.claim_operational_state
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
