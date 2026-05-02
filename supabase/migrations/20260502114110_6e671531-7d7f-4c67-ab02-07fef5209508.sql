
-- 1. Audit table
CREATE TABLE IF NOT EXISTS public.check_status_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_intake_item_id uuid NOT NULL REFERENCES public.check_intake_items(id) ON DELETE CASCADE,
  from_status text,
  to_status text NOT NULL,
  changed_by uuid,
  changed_at timestamptz NOT NULL DEFAULT now(),
  reason text,
  source text NOT NULL DEFAULT 'app'
);
CREATE INDEX IF NOT EXISTS idx_check_status_audit_check
  ON public.check_status_audit(check_intake_item_id, changed_at DESC);
ALTER TABLE public.check_status_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins and staff can read check status audit"
  ON public.check_status_audit FOR SELECT
  USING (public.has_role(auth.uid(), 'admin'::app_role) OR public.has_role(auth.uid(), 'staff'::app_role));

-- 2. State machine trigger
CREATE OR REPLACE FUNCTION public.enforce_check_status_transition()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  allowed_statuses text[] := ARRAY[
    'uploaded','needs_review','endorsing','approved_for_deposit',
    'loss_draft_required','branch_deposit_required','deposited'
  ];
  valid_transitions jsonb := '{
    "uploaded": ["needs_review","endorsing","approved_for_deposit","loss_draft_required","branch_deposit_required"],
    "needs_review": ["uploaded","endorsing","approved_for_deposit","loss_draft_required","branch_deposit_required"],
    "endorsing": ["needs_review","approved_for_deposit","loss_draft_required","branch_deposit_required"],
    "approved_for_deposit": ["deposited","needs_review"],
    "loss_draft_required": ["approved_for_deposit","needs_review","deposited"],
    "branch_deposit_required": ["deposited","needs_review"],
    "deposited": []
  }'::jsonb;
  next_allowed jsonb;
BEGIN
  IF NEW.status IS NULL THEN RAISE EXCEPTION 'check status cannot be null'; END IF;
  IF NOT (NEW.status = ANY(allowed_statuses)) THEN
    RAISE EXCEPTION 'invalid check status: %', NEW.status;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN
    next_allowed := valid_transitions -> OLD.status;
    IF next_allowed IS NULL OR NOT (next_allowed ? NEW.status) THEN
      RAISE EXCEPTION 'invalid check status transition: % -> %', OLD.status, NEW.status;
    END IF;
    INSERT INTO public.check_status_audit(check_intake_item_id, from_status, to_status, changed_by, source)
    VALUES (NEW.id, OLD.status, NEW.status, auth.uid(), 'trigger');
  ELSIF TG_OP = 'INSERT' THEN
    INSERT INTO public.check_status_audit(check_intake_item_id, from_status, to_status, changed_by, source)
    VALUES (NEW.id, NULL, NEW.status, auth.uid(), 'trigger');
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_enforce_check_status ON public.check_intake_items;
CREATE TRIGGER trg_enforce_check_status
  BEFORE INSERT OR UPDATE OF status ON public.check_intake_items
  FOR EACH ROW EXECUTE FUNCTION public.enforce_check_status_transition();

-- 3. Reconciliation alerts
CREATE TABLE IF NOT EXISTS public.check_reconciliation_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_type text NOT NULL,
  severity text NOT NULL DEFAULT 'warning',
  check_intake_item_id uuid REFERENCES public.check_intake_items(id) ON DELETE CASCADE,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolved boolean NOT NULL DEFAULT false,
  resolved_at timestamptz,
  resolved_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_check_recon_unresolved
  ON public.check_reconciliation_alerts(resolved, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_check_recon_check
  ON public.check_reconciliation_alerts(check_intake_item_id);
ALTER TABLE public.check_reconciliation_alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins and staff can read recon alerts"
  ON public.check_reconciliation_alerts FOR SELECT
  USING (public.has_role(auth.uid(), 'admin'::app_role) OR public.has_role(auth.uid(), 'staff'::app_role));
CREATE POLICY "Admins and staff can resolve recon alerts"
  ON public.check_reconciliation_alerts FOR UPDATE
  USING (public.has_role(auth.uid(), 'admin'::app_role) OR public.has_role(auth.uid(), 'staff'::app_role));
CREATE POLICY "Service role can insert recon alerts"
  ON public.check_reconciliation_alerts FOR INSERT
  WITH CHECK (true);

-- 4. Stuck checks RPC
CREATE OR REPLACE FUNCTION public.get_stuck_checks()
RETURNS TABLE (
  id uuid, claim_id uuid, status text, amount numeric,
  carrier_name text, payee_line text, created_at timestamptz, updated_at timestamptz,
  hours_in_status numeric, sla_hours int, is_overdue boolean
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT (public.has_role(auth.uid(), 'admin'::app_role) OR public.has_role(auth.uid(), 'staff'::app_role)) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  RETURN QUERY
  WITH last_change AS (
    SELECT check_intake_item_id, MAX(changed_at) AS last_changed_at
    FROM public.check_status_audit GROUP BY check_intake_item_id
  ),
  sla AS (
    SELECT * FROM (VALUES
      ('uploaded', 24),
      ('needs_review', 48),
      ('endorsing', 72),
      ('approved_for_deposit', 24),
      ('loss_draft_required', 168),
      ('branch_deposit_required', 48),
      ('deposited', 168)
    ) AS s(status, sla_hours)
  )
  SELECT c.id, c.claim_id, c.status, c.amount, c.carrier_name, c.payee_line,
         c.created_at, c.updated_at,
         EXTRACT(EPOCH FROM (now() - COALESCE(lc.last_changed_at, c.created_at))) / 3600.0,
         sla.sla_hours,
         (EXTRACT(EPOCH FROM (now() - COALESCE(lc.last_changed_at, c.created_at))) / 3600.0) > sla.sla_hours
  FROM public.check_intake_items c
  LEFT JOIN last_change lc ON lc.check_intake_item_id = c.id
  JOIN sla ON sla.status = c.status
  ORDER BY EXTRACT(EPOCH FROM (now() - COALESCE(lc.last_changed_at, c.created_at))) DESC;
END;
$$;

-- 5. All-checks safety net RPC
CREATE OR REPLACE FUNCTION public.get_all_checks_safety_net()
RETURNS TABLE (
  id uuid, claim_id uuid, status text, amount numeric, check_number text,
  carrier_name text, payee_line text, front_image_path text, back_image_path text,
  created_at timestamptz, updated_at timestamptz, has_loss_draft boolean
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT (public.has_role(auth.uid(), 'admin'::app_role) OR public.has_role(auth.uid(), 'staff'::app_role)) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  RETURN QUERY
  SELECT c.id, c.claim_id, c.status, c.amount, c.check_number,
         c.carrier_name, c.payee_line, c.front_image_path, c.back_image_path,
         c.created_at, c.updated_at,
         EXISTS(SELECT 1 FROM public.loss_draft_tracking ld WHERE ld.check_intake_item_id = c.id)
  FROM public.check_intake_items c
  ORDER BY c.created_at DESC;
END;
$$;
