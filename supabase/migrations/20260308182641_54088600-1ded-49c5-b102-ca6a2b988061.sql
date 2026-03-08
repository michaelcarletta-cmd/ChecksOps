
-- Phase 10: Production-safe automation, approval-aware bulk actions, automation health tracking

-- 1. Automation run log for cron audit trail
CREATE TABLE public.deposit_automation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_date date NOT NULL DEFAULT CURRENT_DATE,
  run_type text NOT NULL DEFAULT 'daily',
  status text NOT NULL DEFAULT 'running', -- running, completed, partial_failure, failed
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  steps_completed jsonb DEFAULT '[]'::jsonb,
  steps_failed jsonb DEFAULT '[]'::jsonb,
  refresh_count int DEFAULT 0,
  escalations_created int DEFAULT 0,
  digests_generated int DEFAULT 0,
  deliveries_sent int DEFAULT 0,
  overload_flags jsonb DEFAULT '[]'::jsonb,
  error_summary text,
  duration_ms int,
  idempotency_key text UNIQUE,
  created_at timestamptz DEFAULT now()
);

-- Index for dedup: only one successful daily run per day+type
CREATE UNIQUE INDEX idx_automation_runs_daily_dedup 
  ON deposit_automation_runs (run_date, run_type) 
  WHERE status IN ('completed', 'running');

-- RLS
ALTER TABLE deposit_automation_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Staff and admin can view automation runs"
  ON deposit_automation_runs FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff'));

-- 2. Deposit automation settings (configurable thresholds)
CREATE TABLE public.deposit_automation_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  setting_key text UNIQUE NOT NULL,
  setting_value jsonb NOT NULL,
  description text,
  updated_at timestamptz DEFAULT now(),
  updated_by uuid
);

ALTER TABLE deposit_automation_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Staff and admin can view settings"
  ON deposit_automation_settings FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff'));
CREATE POLICY "Admin can update settings"
  ON deposit_automation_settings FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Admin can insert settings"
  ON deposit_automation_settings FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Seed default settings
INSERT INTO deposit_automation_settings (setting_key, setting_value, description) VALUES
  ('owner_overload_threshold', '25'::jsonb, 'Max open items per owner before overload flag'),
  ('approval_required_rebalance', 'true'::jsonb, 'Require manager approval for workload rebalance'),
  ('approval_required_bulk_closeout', 'true'::jsonb, 'Require manager approval for bulk closeout'),
  ('approval_required_bulk_resolve', 'true'::jsonb, 'Require manager approval for bulk exception resolution'),
  ('daily_automation_enabled', 'true'::jsonb, 'Enable daily automation cron job');

-- 3. Add resend capability to delivery log
ALTER TABLE deposit_digest_delivery_log ADD COLUMN IF NOT EXISTS resent_at timestamptz;
ALTER TABLE deposit_digest_delivery_log ADD COLUMN IF NOT EXISTS resent_by uuid;
ALTER TABLE deposit_digest_delivery_log ADD COLUMN IF NOT EXISTS error_message text;

-- 4. RPC to check if approval is required for an action type
CREATE OR REPLACE FUNCTION public.is_approval_required(p_action_type text)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_val jsonb;
BEGIN
  SELECT setting_value INTO v_val FROM deposit_automation_settings 
  WHERE setting_key = 'approval_required_' || p_action_type;
  RETURN COALESCE(v_val::text = 'true', false);
END;
$$;

-- 5. RPC to get a setting value
CREATE OR REPLACE FUNCTION public.get_deposit_setting(p_key text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_val jsonb;
BEGIN
  SELECT setting_value INTO v_val FROM deposit_automation_settings WHERE setting_key = p_key;
  RETURN v_val;
END;
$$;
