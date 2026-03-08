
-- Phase 9: Automation execution, manager workflows, snapshots, escalation routing

-- 1) Manager KPI snapshots for day-over-day trend comparison
CREATE TABLE public.deposit_manager_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_date date NOT NULL DEFAULT CURRENT_DATE,
  snapshot_type text NOT NULL DEFAULT 'daily',
  kpi_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  queue_data jsonb NOT NULL DEFAULT '[]'::jsonb,
  owner_data jsonb NOT NULL DEFAULT '[]'::jsonb,
  exception_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(snapshot_date, snapshot_type)
);

ALTER TABLE public.deposit_manager_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Staff can read snapshots" ON public.deposit_manager_snapshots FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "System can insert snapshots" ON public.deposit_manager_snapshots FOR INSERT TO authenticated WITH CHECK (public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'admin'));

-- 2) Owner notification preferences
CREATE TABLE public.deposit_notification_prefs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  digest_frequency text NOT NULL DEFAULT 'daily', -- daily, weekly, none
  notify_sla_breach boolean DEFAULT true,
  notify_exception_assigned boolean DEFAULT true,
  notify_rebalance boolean DEFAULT true,
  notify_closeout_ready boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(user_id)
);

ALTER TABLE public.deposit_notification_prefs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can read own prefs" ON public.deposit_notification_prefs FOR SELECT TO authenticated USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Users can upsert own prefs" ON public.deposit_notification_prefs FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "Users can update own prefs" ON public.deposit_notification_prefs FOR UPDATE TO authenticated USING (user_id = auth.uid());

-- 3) Digest delivery log
CREATE TABLE public.deposit_digest_delivery_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  digest_id uuid REFERENCES deposit_daily_digest(id),
  recipient_id uuid NOT NULL,
  delivery_method text NOT NULL DEFAULT 'in_app', -- in_app, email
  delivered_at timestamptz DEFAULT now(),
  read_at timestamptz,
  error_message text
);

ALTER TABLE public.deposit_digest_delivery_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Staff can read delivery logs" ON public.deposit_digest_delivery_log FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "System can insert delivery logs" ON public.deposit_digest_delivery_log FOR INSERT TO authenticated WITH CHECK (public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'admin'));

-- 4) Escalation routing rules
CREATE TABLE public.deposit_escalation_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_name text NOT NULL,
  trigger_type text NOT NULL, -- stale_exception, unreconciled_cash, unsynced_accounting, unassigned_item, sla_breach
  threshold_days int DEFAULT 3,
  threshold_amount numeric DEFAULT 0,
  escalate_to_role text DEFAULT 'admin', -- admin, manager
  auto_reassign boolean DEFAULT false,
  auto_flag boolean DEFAULT true,
  notification_message text,
  is_active boolean DEFAULT true,
  priority int DEFAULT 1,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE public.deposit_escalation_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Staff can read escalation rules" ON public.deposit_escalation_rules FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Admin can manage escalation rules" ON public.deposit_escalation_rules FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Seed default escalation rules
INSERT INTO deposit_escalation_rules (rule_name, trigger_type, threshold_days, threshold_amount, escalate_to_role, notification_message) VALUES
  ('Stale open exception', 'stale_exception', 3, 0, 'admin', 'Exception open > 3 days without resolution'),
  ('High-value unreconciled', 'unreconciled_cash', 5, 5000, 'admin', 'Unreconciled deposit > $5,000 aged 5+ days'),
  ('Unsynced accounting', 'unsynced_accounting', 5, 0, 'admin', 'Reconciled item not synced to accounting in 5 days'),
  ('Unassigned items', 'unassigned_item', 1, 0, 'admin', 'Deposit item unassigned for > 1 day'),
  ('Deposit SLA breach', 'sla_breach', 2, 0, 'admin', 'Deposit exceeding SLA threshold');

-- 5) Pending manager approvals
CREATE TABLE public.deposit_pending_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_type text NOT NULL, -- rebalance, bulk_closeout, bulk_resolve
  requested_by uuid NOT NULL,
  requested_at timestamptz DEFAULT now(),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  item_count int DEFAULT 0,
  total_amount numeric DEFAULT 0,
  description text,
  status text NOT NULL DEFAULT 'pending', -- pending, approved, rejected
  reviewed_by uuid,
  reviewed_at timestamptz,
  review_notes text,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.deposit_pending_approvals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Staff can read approvals" ON public.deposit_pending_approvals FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Staff can create approvals" ON public.deposit_pending_approvals FOR INSERT TO authenticated WITH CHECK (public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Admin can update approvals" ON public.deposit_pending_approvals FOR UPDATE TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- 6) Escalation events log
CREATE TABLE public.deposit_escalation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id uuid REFERENCES deposit_escalation_rules(id),
  deposit_item_id uuid REFERENCES deposit_items(id),
  exception_id uuid REFERENCES deposit_exceptions(id),
  escalation_type text NOT NULL,
  escalated_to uuid,
  message text,
  is_resolved boolean DEFAULT false,
  resolved_at timestamptz,
  resolved_by uuid,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.deposit_escalation_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Staff can read escalation events" ON public.deposit_escalation_events FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "System can insert escalation events" ON public.deposit_escalation_events FOR INSERT TO authenticated WITH CHECK (public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Staff can update escalation events" ON public.deposit_escalation_events FOR UPDATE TO authenticated USING (public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'admin'));

-- 7) RPC: save_deposit_manager_snapshot
CREATE OR REPLACE FUNCTION public.save_deposit_manager_snapshot(p_actor_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_kpi jsonb;
  v_exc_kpi jsonb;
  v_queue jsonb;
  v_owners jsonb;
BEGIN
  IF NOT has_role(p_actor_id, 'staff') AND NOT has_role(p_actor_id, 'admin') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT row_to_json(k.*) INTO v_kpi FROM deposit_ops_kpis k;
  SELECT row_to_json(k.*) INTO v_exc_kpi FROM deposit_exception_kpis k;
  SELECT COALESCE(jsonb_agg(row_to_json(q.*)), '[]'::jsonb) INTO v_queue
  FROM (SELECT id, check_number, amount, status, priority_score, next_action, owner_id FROM deposit_queue_scored ORDER BY priority_score DESC LIMIT 20) q;
  SELECT COALESCE(jsonb_agg(row_to_json(o.*)), '[]'::jsonb) INTO v_owners FROM deposit_owner_performance o WHERE owner_id IS NOT NULL;

  INSERT INTO deposit_manager_snapshots (snapshot_date, snapshot_type, kpi_data, queue_data, owner_data, exception_data)
  VALUES (CURRENT_DATE, 'daily', COALESCE(v_kpi, '{}'::jsonb), v_queue, v_owners, COALESCE(v_exc_kpi, '{}'::jsonb))
  ON CONFLICT (snapshot_date, snapshot_type) DO UPDATE SET
    kpi_data = COALESCE(v_kpi, '{}'::jsonb), queue_data = v_queue, owner_data = v_owners,
    exception_data = COALESCE(v_exc_kpi, '{}'::jsonb), created_at = now();

  RETURN jsonb_build_object('success', true);
END;
$$;

-- 8) RPC: submit_manager_approval
CREATE OR REPLACE FUNCTION public.submit_manager_approval(
  p_approval_type text, p_actor_id uuid, p_payload jsonb,
  p_item_count int DEFAULT 0, p_total_amount numeric DEFAULT 0, p_description text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT has_role(p_actor_id, 'staff') AND NOT has_role(p_actor_id, 'admin') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  INSERT INTO deposit_pending_approvals (approval_type, requested_by, payload, item_count, total_amount, description)
  VALUES (p_approval_type, p_actor_id, p_payload, p_item_count, p_total_amount, p_description)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('success', true, 'approval_id', v_id);
END;
$$;

-- 9) RPC: review_manager_approval (approve or reject, then execute if approved)
CREATE OR REPLACE FUNCTION public.review_manager_approval(p_approval_id uuid, p_reviewer_id uuid, p_decision text, p_notes text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_appr record;
  v_result jsonb;
BEGIN
  IF NOT has_role(p_reviewer_id, 'admin') THEN
    RAISE EXCEPTION 'Only admins can review approvals';
  END IF;

  SELECT * INTO v_appr FROM deposit_pending_approvals WHERE id = p_approval_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Approval not found'; END IF;
  IF v_appr.status != 'pending' THEN RAISE EXCEPTION 'Approval already reviewed'; END IF;

  UPDATE deposit_pending_approvals SET
    status = p_decision, reviewed_by = p_reviewer_id, reviewed_at = now(), review_notes = p_notes
  WHERE id = p_approval_id;

  IF p_decision = 'approved' THEN
    CASE v_appr.approval_type
      WHEN 'rebalance' THEN
        SELECT rebalance_deposit_workload(p_reviewer_id) INTO v_result;
      WHEN 'bulk_closeout' THEN
        SELECT bulk_deposit_closeout(
          (SELECT array_agg(x::uuid) FROM jsonb_array_elements_text(v_appr.payload->'item_ids') x),
          p_reviewer_id
        ) INTO v_result;
      WHEN 'bulk_resolve' THEN
        SELECT bulk_resolve_deposit_exceptions(
          (SELECT array_agg(x::uuid) FROM jsonb_array_elements_text(v_appr.payload->'exception_ids') x),
          p_reviewer_id,
          COALESCE(p_notes, 'Manager approved bulk resolution')
        ) INTO v_result;
      ELSE
        v_result := jsonb_build_object('note', 'Unknown approval type, no action taken');
    END CASE;
  END IF;

  RETURN jsonb_build_object('success', true, 'decision', p_decision, 'execution_result', COALESCE(v_result, '{}'::jsonb));
END;
$$;

-- 10) RPC: run_deposit_escalation_check
CREATE OR REPLACE FUNCTION public.run_deposit_escalation_check(p_actor_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_rule record;
  v_item record;
  v_exc record;
  v_count int := 0;
  v_admin_id uuid;
BEGIN
  -- Get first admin for escalation target
  SELECT user_id INTO v_admin_id FROM user_roles WHERE role = 'admin' LIMIT 1;

  FOR v_rule IN SELECT * FROM deposit_escalation_rules WHERE is_active = true ORDER BY priority
  LOOP
    CASE v_rule.trigger_type
      WHEN 'stale_exception' THEN
        FOR v_exc IN
          SELECT de.id as exc_id, de.deposit_item_id FROM deposit_exceptions de
          WHERE de.resolved_at IS NULL AND de.created_at < now() - (v_rule.threshold_days || ' days')::interval
            AND NOT EXISTS (SELECT 1 FROM deposit_escalation_events ee WHERE ee.exception_id = de.id AND ee.rule_id = v_rule.id AND NOT ee.is_resolved)
        LOOP
          INSERT INTO deposit_escalation_events (rule_id, deposit_item_id, exception_id, escalation_type, escalated_to, message)
          VALUES (v_rule.id, v_exc.deposit_item_id, v_exc.exc_id, v_rule.trigger_type, v_admin_id, v_rule.notification_message);
          v_count := v_count + 1;
        END LOOP;

      WHEN 'unreconciled_cash' THEN
        FOR v_item IN
          SELECT di.id FROM deposit_items di
          WHERE di.status = 'succeeded' AND di.reconciled_at IS NULL AND NOT di.closeout_complete
            AND di.cleared_at < now() - (v_rule.threshold_days || ' days')::interval
            AND di.amount >= v_rule.threshold_amount
            AND NOT EXISTS (SELECT 1 FROM deposit_escalation_events ee WHERE ee.deposit_item_id = di.id AND ee.escalation_type = 'unreconciled_cash' AND ee.rule_id = v_rule.id AND NOT ee.is_resolved)
        LOOP
          INSERT INTO deposit_escalation_events (rule_id, deposit_item_id, escalation_type, escalated_to, message)
          VALUES (v_rule.id, v_item.id, v_rule.trigger_type, v_admin_id, v_rule.notification_message);
          v_count := v_count + 1;
        END LOOP;

      WHEN 'unsynced_accounting' THEN
        FOR v_item IN
          SELECT di.id FROM deposit_items di
          WHERE di.reconciled_at IS NOT NULL AND di.accounting_synced_at IS NULL AND NOT di.closeout_complete
            AND di.reconciled_at < now() - (v_rule.threshold_days || ' days')::interval
            AND NOT EXISTS (SELECT 1 FROM deposit_escalation_events ee WHERE ee.deposit_item_id = di.id AND ee.escalation_type = 'unsynced_accounting' AND ee.rule_id = v_rule.id AND NOT ee.is_resolved)
        LOOP
          INSERT INTO deposit_escalation_events (rule_id, deposit_item_id, escalation_type, escalated_to, message)
          VALUES (v_rule.id, v_item.id, v_rule.trigger_type, v_admin_id, v_rule.notification_message);
          v_count := v_count + 1;
        END LOOP;

      WHEN 'unassigned_item' THEN
        FOR v_item IN
          SELECT di.id FROM deposit_items di
          WHERE di.owner_id IS NULL AND NOT di.closeout_complete AND di.status NOT IN ('failed','returned')
            AND di.created_at < now() - (v_rule.threshold_days || ' days')::interval
            AND NOT EXISTS (SELECT 1 FROM deposit_escalation_events ee WHERE ee.deposit_item_id = di.id AND ee.escalation_type = 'unassigned_item' AND ee.rule_id = v_rule.id AND NOT ee.is_resolved)
        LOOP
          INSERT INTO deposit_escalation_events (rule_id, deposit_item_id, escalation_type, escalated_to, message)
          VALUES (v_rule.id, v_item.id, v_rule.trigger_type, v_admin_id, v_rule.notification_message);
          v_count := v_count + 1;
        END LOOP;

      WHEN 'sla_breach' THEN
        FOR v_item IN
          SELECT di.id FROM deposit_items di
          WHERE NOT di.closeout_complete AND di.status NOT IN ('failed','returned')
            AND di.created_at < now() - (v_rule.threshold_days || ' days')::interval
            AND (
              (di.status IN ('pending_assignment','provider_assigned') AND di.cleared_at IS NULL)
              OR (di.status = 'succeeded' AND di.bank_confirmed_at IS NULL AND di.cleared_at < now() - interval '3 days')
            )
            AND NOT EXISTS (SELECT 1 FROM deposit_escalation_events ee WHERE ee.deposit_item_id = di.id AND ee.escalation_type = 'sla_breach' AND ee.rule_id = v_rule.id AND NOT ee.is_resolved)
        LOOP
          INSERT INTO deposit_escalation_events (rule_id, deposit_item_id, escalation_type, escalated_to, message)
          VALUES (v_rule.id, v_item.id, v_rule.trigger_type, v_admin_id, v_rule.notification_message);
          v_count := v_count + 1;
        END LOOP;

      ELSE NULL;
    END CASE;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'escalations_created', v_count);
END;
$$;
