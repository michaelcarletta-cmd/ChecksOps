-- Mortgage Agent registry + compensation payable ledger (SQL 47).
-- Staging / local only in this phase. Do not apply to production.
--
-- Additive overlay. Does not:
--   ALTER mortgage_handling_requests
--   GRANT UPDATE ON TABLE mortgage_handling_requests
--   ALTER check_billing_events
--   INSERT tenant usage events
--   modify the existing Mortgage Ops agent helper / SQL 39
--   reference provider money rails or the fail-closed billing stub
--
-- Tenant receivable remains Accept-time check_billing_events.
-- Agent payable is earned only at successful Complete.

-- ---------------------------------------------------------------------------
-- 1) Agent administrative roster
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.mortgage_agent_accounts (
  application_user_id uuid PRIMARY KEY,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive')),
  hired_at timestamptz NOT NULL DEFAULT now(),
  deactivated_at timestamptz,
  deactivated_by uuid,
  deactivate_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.mortgage_agent_accounts IS
  'Administrative Mortgage Agent roster. Does not replace user_roles.mortgage_agent. Deactivate must not delete the role or rewrite historical work.';

CREATE INDEX IF NOT EXISTS mortgage_agent_accounts_status_idx
  ON public.mortgage_agent_accounts (status);

-- ---------------------------------------------------------------------------
-- 2) Internal compensation rates (not a tenant-facing editor)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.mortgage_agent_compensation_rates (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  initial_cents integer NOT NULL DEFAULT 1000 CHECK (initial_cents >= 0),
  additional_cents integer NOT NULL DEFAULT 500 CHECK (additional_cents >= 0),
  effective_from timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.mortgage_agent_compensation_rates (singleton, initial_cents, additional_cents)
VALUES (true, 1000, 500)
ON CONFLICT (singleton) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3) Explicit exclusion / future-backfill controls
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.mortgage_agent_compensation_exclusions (
  mortgage_request_id uuid PRIMARY KEY,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.mortgage_agent_compensation_exclusions (mortgage_request_id, reason)
VALUES
  (
    '5b20db20-13e1-4919-9528-06388d8661d2',
    'Accidental Freedom Accept during production Mortgage Ops acceptance. Do not compensate. Do not mutate the request.'
  ),
  (
    '7a7ec1ce-de9a-4601-875c-4a67db635fd2',
    'Synthetic production acceptance fixture PROD-MOPS-20261003-A. Not legitimate agent pay.'
  ),
  (
    '71ea6822-df95-4aa9-a04c-4a00a5f6d043',
    'Synthetic production acceptance fixture PROD-MOPS-20261003-B. Not legitimate agent pay.'
  )
ON CONFLICT (mortgage_request_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4) Payment batches + payable ledger + audit
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.mortgage_agent_compensation_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pay_period text,
  agent_user_id uuid,
  action text NOT NULL CHECK (action IN ('approve', 'pay')),
  payment_date date,
  payment_reference text,
  note text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.mortgage_agent_compensation_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_user_id uuid NOT NULL,
  mortgage_request_id uuid NOT NULL,
  check_intake_item_id uuid,
  claim_id uuid,
  tenant_id uuid,
  classification text NOT NULL CHECK (classification IN ('initial', 'additional')),
  amount_cents integer NOT NULL,
  tenant_billing_event_id uuid,
  tenant_billing_event_type text,
  tenant_billing_amount_cents integer,
  accepted_at timestamptz,
  completed_at timestamptz,
  earned_at timestamptz NOT NULL DEFAULT now(),
  pay_period text NOT NULL,
  status text NOT NULL DEFAULT 'earned'
    CHECK (status IN ('earned', 'approved', 'paid', 'voided', 'excluded')),
  payment_batch_id uuid REFERENCES public.mortgage_agent_compensation_batches(id),
  payment_date date,
  payment_reference text,
  payment_note text,
  approved_by uuid,
  approved_at timestamptz,
  paid_by uuid,
  paid_at timestamptz,
  parent_entry_id uuid REFERENCES public.mortgage_agent_compensation_entries(id),
  exclusion_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS mortgage_agent_compensation_entries_request_live_uidx
  ON public.mortgage_agent_compensation_entries (mortgage_request_id)
  WHERE parent_entry_id IS NULL
    AND status NOT IN ('voided', 'excluded');

CREATE UNIQUE INDEX IF NOT EXISTS mortgage_agent_compensation_entries_check_live_uidx
  ON public.mortgage_agent_compensation_entries (check_intake_item_id)
  WHERE parent_entry_id IS NULL
    AND check_intake_item_id IS NOT NULL
    AND status NOT IN ('voided', 'excluded');

CREATE INDEX IF NOT EXISTS mortgage_agent_compensation_entries_period_idx
  ON public.mortgage_agent_compensation_entries (pay_period, agent_user_id, status);

CREATE INDEX IF NOT EXISTS mortgage_agent_compensation_entries_agent_idx
  ON public.mortgage_agent_compensation_entries (agent_user_id, earned_at DESC);

CREATE TABLE IF NOT EXISTS public.mortgage_agent_compensation_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id uuid,
  batch_id uuid,
  actor_id uuid,
  action text NOT NULL,
  from_status text,
  to_status text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mortgage_agent_compensation_audit_entry_idx
  ON public.mortgage_agent_compensation_audit (entry_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 5) Helpers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.aws_is_active_mortgage_agent(_user_id uuid DEFAULT auth.uid())
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT
    _user_id IS NOT NULL
    AND public.has_role(_user_id, 'mortgage_agent'::public.app_role)
    AND NOT EXISTS (
      SELECT 1
      FROM public.mortgage_agent_accounts a
      WHERE a.application_user_id = _user_id
        AND a.status = 'inactive'
    );
$$;

COMMENT ON FUNCTION public.aws_is_active_mortgage_agent(uuid) IS
  'True when the user holds mortgage_agent and is not administratively inactive. Missing roster row is treated as active so existing agents are not locked out. Does not replace the existing Mortgage Ops agent helper.';

CREATE OR REPLACE FUNCTION public.aws_can_admin_mortgage_agent_compensation()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT COALESCE(public.is_master_owner(), false)
      OR COALESCE(public.is_platform_owner(), false)
      OR public.has_role(auth.uid(), 'admin'::public.app_role);
$$;

CREATE OR REPLACE FUNCTION public.tg_reject_inactive_mortgage_agent_accept()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.status = 'requested'
     AND OLD.assigned_employee_id IS NULL
     AND NEW.status = 'in_progress'
     AND NEW.assigned_employee_id IS NOT NULL
     AND NOT public.aws_is_active_mortgage_agent(NEW.assigned_employee_id)
  THEN
    RAISE EXCEPTION 'agent_inactive'
      USING ERRCODE = '42501',
            DETAIL = 'Inactive Mortgage Agents cannot accept new work.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_reject_inactive_mortgage_agent_accept ON public.mortgage_handling_requests;
CREATE TRIGGER tr_reject_inactive_mortgage_agent_accept
  BEFORE UPDATE OF status, assigned_employee_id ON public.mortgage_handling_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_reject_inactive_mortgage_agent_accept();

-- ---------------------------------------------------------------------------
-- 6) Earn at Complete (idempotent)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.earn_mortgage_agent_compensation(p_request_id uuid)
RETURNS public.mortgage_agent_compensation_entries
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_req public.mortgage_handling_requests%ROWTYPE;
  v_existing public.mortgage_agent_compensation_entries%ROWTYPE;
  v_inserted public.mortgage_agent_compensation_entries%ROWTYPE;
  v_event_id uuid;
  v_event_type text;
  v_event_cents integer;
  v_classification text;
  v_amount integer;
  v_initial integer;
  v_additional integer;
  v_prior integer;
  v_period text;
BEGIN
  IF p_request_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_req
  FROM public.mortgage_handling_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.mortgage_agent_compensation_exclusions x
    WHERE x.mortgage_request_id = v_req.id
  ) THEN
    RETURN NULL;
  END IF;

  IF v_req.status IS DISTINCT FROM 'completed'
     OR v_req.completed_at IS NULL
     OR v_req.assigned_employee_id IS NULL
  THEN
    RETURN NULL;
  END IF;

  SELECT e.* INTO v_existing
  FROM public.mortgage_agent_compensation_entries e
  WHERE e.mortgage_request_id = v_req.id
    AND e.parent_entry_id IS NULL
    AND e.status NOT IN ('voided', 'excluded')
  LIMIT 1;
  IF FOUND THEN
    RETURN v_existing;
  END IF;

  SELECT r.initial_cents, r.additional_cents
  INTO v_initial, v_additional
  FROM public.mortgage_agent_compensation_rates r
  WHERE r.singleton IS TRUE
  LIMIT 1;
  v_initial := COALESCE(v_initial, 1000);
  v_additional := COALESCE(v_additional, 500);

  BEGIN
    SELECT e.id, e.event_type, e.unit_price_cents
    INTO v_event_id, v_event_type, v_event_cents
    FROM public.check_billing_events e
    WHERE e.check_intake_item_id IS NOT DISTINCT FROM v_req.check_intake_item_id
      AND e.event_type IN ('mortgage_ops_initial', 'mortgage_ops_additional_check')
      AND e.status IS DISTINCT FROM 'voided'
    ORDER BY e.created_at ASC
    LIMIT 1;
  EXCEPTION
    WHEN undefined_table THEN
      v_event_id := NULL;
    WHEN undefined_column THEN
      v_event_id := NULL;
  END;

  IF v_event_type = 'mortgage_ops_additional_check' THEN
    v_classification := 'additional';
  ELSIF v_event_type = 'mortgage_ops_initial' THEN
    v_classification := 'initial';
  ELSE
    v_prior := 0;
    IF v_req.claim_id IS NOT NULL AND v_req.tenant_id IS NOT NULL THEN
      SELECT count(*)::int INTO v_prior
      FROM public.mortgage_handling_requests r
      WHERE r.tenant_id = v_req.tenant_id
        AND r.claim_id = v_req.claim_id
        AND r.status = 'completed'
        AND r.completed_at IS NOT NULL
        AND r.id IS DISTINCT FROM v_req.id
        AND NOT EXISTS (
          SELECT 1
          FROM public.mortgage_agent_compensation_exclusions x
          WHERE x.mortgage_request_id = r.id
        );
    END IF;
    IF COALESCE(v_prior, 0) > 0 THEN
      v_classification := 'additional';
    ELSE
      v_classification := 'initial';
    END IF;
  END IF;

  IF v_classification = 'additional' THEN
    v_amount := v_additional;
  ELSE
    v_amount := v_initial;
  END IF;

  v_period := to_char(timezone('UTC', v_req.completed_at), 'YYYY-MM');

  INSERT INTO public.mortgage_agent_compensation_entries (
    agent_user_id,
    mortgage_request_id,
    check_intake_item_id,
    claim_id,
    tenant_id,
    classification,
    amount_cents,
    tenant_billing_event_id,
    tenant_billing_event_type,
    tenant_billing_amount_cents,
    accepted_at,
    completed_at,
    earned_at,
    pay_period,
    status
  ) VALUES (
    v_req.assigned_employee_id,
    v_req.id,
    v_req.check_intake_item_id,
    v_req.claim_id,
    v_req.tenant_id,
    v_classification,
    v_amount,
    v_event_id,
    v_event_type,
    v_event_cents,
    v_req.accepted_at,
    v_req.completed_at,
    v_req.completed_at,
    v_period,
    'earned'
  )
  ON CONFLICT DO NOTHING
  RETURNING * INTO v_inserted;

  IF v_inserted.id IS NULL THEN
    SELECT e.* INTO v_inserted
    FROM public.mortgage_agent_compensation_entries e
    WHERE e.mortgage_request_id = v_req.id
      AND e.parent_entry_id IS NULL
      AND e.status NOT IN ('voided', 'excluded')
    LIMIT 1;
  ELSE
    INSERT INTO public.mortgage_agent_compensation_audit (
      entry_id, actor_id, action, from_status, to_status, payload
    ) VALUES (
      v_inserted.id,
      v_req.assigned_employee_id,
      'earn',
      NULL,
      'earned',
      jsonb_build_object(
        'mortgage_request_id', v_req.id,
        'classification', v_classification,
        'amount_cents', v_amount
      )
    );
  END IF;

  RETURN v_inserted;
END;
$$;

CREATE OR REPLACE FUNCTION public.tg_earn_mortgage_agent_compensation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
BEGIN
  IF NEW.status = 'completed' AND NEW.completed_at IS NOT NULL THEN
    BEGIN
      PERFORM public.earn_mortgage_agent_compensation(NEW.id);
    EXCEPTION
      WHEN unique_violation THEN
        NULL;
    END;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_earn_mortgage_agent_compensation ON public.mortgage_handling_requests;
CREATE TRIGGER tr_earn_mortgage_agent_compensation
  AFTER UPDATE OF status, completed_at ON public.mortgage_handling_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_earn_mortgage_agent_compensation();

-- ---------------------------------------------------------------------------
-- 7) Immutable historical facts
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tg_protect_mortgage_agent_compensation_facts()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'paid' THEN
      RAISE EXCEPTION 'compensation_paid_immutable';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.agent_user_id IS DISTINCT FROM NEW.agent_user_id
     OR OLD.mortgage_request_id IS DISTINCT FROM NEW.mortgage_request_id
     OR OLD.check_intake_item_id IS DISTINCT FROM NEW.check_intake_item_id
     OR OLD.claim_id IS DISTINCT FROM NEW.claim_id
     OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
     OR OLD.classification IS DISTINCT FROM NEW.classification
     OR OLD.amount_cents IS DISTINCT FROM NEW.amount_cents
     OR OLD.accepted_at IS DISTINCT FROM NEW.accepted_at
     OR OLD.completed_at IS DISTINCT FROM NEW.completed_at
     OR OLD.earned_at IS DISTINCT FROM NEW.earned_at
     OR OLD.pay_period IS DISTINCT FROM NEW.pay_period
  THEN
    RAISE EXCEPTION 'compensation_facts_immutable';
  END IF;

  IF OLD.status = 'paid' AND NEW.status IS DISTINCT FROM 'paid' THEN
    RAISE EXCEPTION 'compensation_paid_immutable';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_protect_mortgage_agent_compensation_facts
  ON public.mortgage_agent_compensation_entries;
CREATE TRIGGER tr_protect_mortgage_agent_compensation_facts
  BEFORE UPDATE OR DELETE ON public.mortgage_agent_compensation_entries
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_protect_mortgage_agent_compensation_facts();

-- ---------------------------------------------------------------------------
-- 8) Admin RPCs (bookkeeping only)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_mortgage_agent_account_status(
  p_agent_user_id uuid,
  p_status text,
  p_note text DEFAULT NULL
) RETURNS public.mortgage_agent_accounts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_row public.mortgage_agent_accounts%ROWTYPE;
BEGIN
  IF NOT public.aws_can_admin_mortgage_agent_compensation() THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  IF p_status NOT IN ('active', 'inactive') THEN
    RAISE EXCEPTION 'invalid_status';
  END IF;

  INSERT INTO public.mortgage_agent_accounts (application_user_id, status)
  VALUES (p_agent_user_id, 'active')
  ON CONFLICT (application_user_id) DO NOTHING;

  UPDATE public.mortgage_agent_accounts
     SET status = p_status,
         deactivated_at = CASE WHEN p_status = 'inactive' THEN now() ELSE NULL END,
         deactivated_by = CASE WHEN p_status = 'inactive' THEN auth.uid() ELSE NULL END,
         deactivate_note = CASE WHEN p_status = 'inactive' THEN p_note ELSE NULL END,
         updated_at = now()
   WHERE application_user_id = p_agent_user_id
   RETURNING * INTO v_row;

  INSERT INTO public.mortgage_agent_compensation_audit (
    actor_id, action, payload
  ) VALUES (
    auth.uid(),
    CASE WHEN p_status = 'inactive' THEN 'deactivate_agent' ELSE 'activate_agent' END,
    jsonb_build_object('agent_user_id', p_agent_user_id, 'note', p_note)
  );

  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.approve_mortgage_agent_compensation(
  p_entry_ids uuid[],
  p_note text DEFAULT NULL
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_batch_id uuid;
  v_count integer := 0;
  v_id uuid;
  v_from text;
BEGIN
  IF NOT public.aws_can_admin_mortgage_agent_compensation() THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  IF p_entry_ids IS NULL OR array_length(p_entry_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;

  INSERT INTO public.mortgage_agent_compensation_batches (
    action, note, created_by
  ) VALUES (
    'approve', p_note, auth.uid()
  ) RETURNING id INTO v_batch_id;

  FOREACH v_id IN ARRAY p_entry_ids LOOP
    SELECT status INTO v_from
    FROM public.mortgage_agent_compensation_entries
    WHERE id = v_id
    FOR UPDATE;
    IF NOT FOUND THEN
      CONTINUE;
    END IF;
    IF v_from IS DISTINCT FROM 'earned' THEN
      CONTINUE;
    END IF;
    UPDATE public.mortgage_agent_compensation_entries
       SET status = 'approved',
           approved_by = auth.uid(),
           approved_at = now(),
           payment_batch_id = COALESCE(payment_batch_id, v_batch_id),
           payment_note = COALESCE(p_note, payment_note)
     WHERE id = v_id
       AND status = 'earned';
    IF FOUND THEN
      v_count := v_count + 1;
      INSERT INTO public.mortgage_agent_compensation_audit (
        entry_id, batch_id, actor_id, action, from_status, to_status, payload
      ) VALUES (
        v_id, v_batch_id, auth.uid(), 'approve', 'earned', 'approved',
        jsonb_build_object('note', p_note)
      );
    END IF;
  END LOOP;

  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_mortgage_agent_compensation_paid(
  p_entry_ids uuid[],
  p_payment_date date DEFAULT CURRENT_DATE,
  p_payment_reference text DEFAULT NULL,
  p_note text DEFAULT NULL
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_batch_id uuid;
  v_count integer := 0;
  v_id uuid;
  v_from text;
BEGIN
  IF NOT public.aws_can_admin_mortgage_agent_compensation() THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  IF p_entry_ids IS NULL OR array_length(p_entry_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;

  INSERT INTO public.mortgage_agent_compensation_batches (
    action, payment_date, payment_reference, note, created_by
  ) VALUES (
    'pay', COALESCE(p_payment_date, CURRENT_DATE), p_payment_reference, p_note, auth.uid()
  ) RETURNING id INTO v_batch_id;

  FOREACH v_id IN ARRAY p_entry_ids LOOP
    SELECT status INTO v_from
    FROM public.mortgage_agent_compensation_entries
    WHERE id = v_id
    FOR UPDATE;
    IF NOT FOUND THEN
      CONTINUE;
    END IF;
    IF v_from NOT IN ('earned', 'approved') THEN
      CONTINUE;
    END IF;
    UPDATE public.mortgage_agent_compensation_entries
       SET status = 'paid',
           payment_batch_id = v_batch_id,
           payment_date = COALESCE(p_payment_date, CURRENT_DATE),
           payment_reference = COALESCE(p_payment_reference, payment_reference),
           payment_note = COALESCE(p_note, payment_note),
           paid_by = auth.uid(),
           paid_at = now(),
           approved_by = COALESCE(approved_by, auth.uid()),
           approved_at = COALESCE(approved_at, now())
     WHERE id = v_id
       AND status IN ('earned', 'approved');
    IF FOUND THEN
      v_count := v_count + 1;
      INSERT INTO public.mortgage_agent_compensation_audit (
        entry_id, batch_id, actor_id, action, from_status, to_status, payload
      ) VALUES (
        v_id, v_batch_id, auth.uid(), 'mark_paid', v_from, 'paid',
        jsonb_build_object(
          'payment_date', COALESCE(p_payment_date, CURRENT_DATE),
          'payment_reference', p_payment_reference,
          'note', p_note
        )
      );
    END IF;
  END LOOP;

  RETURN v_count;
END;
$$;

-- ---------------------------------------------------------------------------
-- 9) Reconciliation (flag only)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mortgage_agent_compensation_reconciliation(
  p_pay_period text DEFAULT NULL
)
RETURNS TABLE (
  anomaly_type text,
  mortgage_request_id uuid,
  compensation_entry_id uuid,
  tenant_billing_event_id uuid,
  detail jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  WITH completed AS (
    SELECT r.*
    FROM public.mortgage_handling_requests r
    WHERE r.status = 'completed'
      AND r.completed_at IS NOT NULL
      AND r.assigned_employee_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.mortgage_agent_compensation_exclusions x
        WHERE x.mortgage_request_id = r.id
      )
      AND (
        p_pay_period IS NULL
        OR to_char(timezone('UTC', r.completed_at), 'YYYY-MM') = p_pay_period
      )
  ),
  live_pay AS (
    SELECT e.*
    FROM public.mortgage_agent_compensation_entries e
    WHERE e.parent_entry_id IS NULL
      AND e.status NOT IN ('voided', 'excluded')
      AND (p_pay_period IS NULL OR e.pay_period = p_pay_period)
  ),
  billing AS (
    SELECT e.id, e.check_intake_item_id, e.mortgage_request_id, e.event_type,
           e.unit_price_cents, e.status
    FROM public.check_billing_events e
    WHERE e.event_type IN ('mortgage_ops_initial', 'mortgage_ops_additional_check')
  )
  SELECT
    'completed_without_compensation'::text,
    c.id,
    NULL::uuid,
    NULL::uuid,
    jsonb_build_object('assigned_employee_id', c.assigned_employee_id, 'completed_at', c.completed_at)
  FROM completed c
  WHERE NOT EXISTS (SELECT 1 FROM live_pay p WHERE p.mortgage_request_id = c.id)

  UNION ALL
  SELECT
    'compensation_without_request',
    p.mortgage_request_id,
    p.id,
    p.tenant_billing_event_id,
    jsonb_build_object('status', p.status, 'amount_cents', p.amount_cents)
  FROM live_pay p
  WHERE NOT EXISTS (SELECT 1 FROM public.mortgage_handling_requests r WHERE r.id = p.mortgage_request_id)

  UNION ALL
  SELECT
    'expected_tenant_billing_missing',
    c.id,
    p.id,
    NULL::uuid,
    jsonb_build_object('accepted_at', c.accepted_at)
  FROM completed c
  LEFT JOIN live_pay p ON p.mortgage_request_id = c.id
  WHERE c.accepted_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM billing b
      WHERE b.mortgage_request_id = c.id
         OR b.check_intake_item_id IS NOT DISTINCT FROM c.check_intake_item_id
    )

  UNION ALL
  SELECT
    'duplicate_tenant_billing',
    c.id,
    p.id,
    NULL::uuid,
    jsonb_build_object('billing_count', (
      SELECT count(*) FROM billing b
      WHERE b.mortgage_request_id = c.id
         OR b.check_intake_item_id IS NOT DISTINCT FROM c.check_intake_item_id
    ))
  FROM completed c
  LEFT JOIN live_pay p ON p.mortgage_request_id = c.id
  WHERE (
    SELECT count(*) FROM billing b
    WHERE b.mortgage_request_id = c.id
       OR b.check_intake_item_id IS NOT DISTINCT FROM c.check_intake_item_id
  ) > 1

  UNION ALL
  SELECT
    'duplicate_compensation',
    p.mortgage_request_id,
    p.id,
    p.tenant_billing_event_id,
    jsonb_build_object('live_count', x.n)
  FROM live_pay p
  JOIN (
    SELECT mortgage_request_id, count(*)::int AS n
    FROM live_pay
    GROUP BY 1
    HAVING count(*) > 1
  ) x ON x.mortgage_request_id = p.mortgage_request_id

  UNION ALL
  SELECT
    'classification_mismatch',
    p.mortgage_request_id,
    p.id,
    p.tenant_billing_event_id,
    jsonb_build_object(
      'agent_classification', p.classification,
      'tenant_event_type', p.tenant_billing_event_type
    )
  FROM live_pay p
  WHERE p.tenant_billing_event_type IS NOT NULL
    AND (
      (p.classification = 'initial' AND p.tenant_billing_event_type IS DISTINCT FROM 'mortgage_ops_initial')
      OR (p.classification = 'additional' AND p.tenant_billing_event_type IS DISTINCT FROM 'mortgage_ops_additional_check')
    )

  UNION ALL
  SELECT
    'amount_mismatch',
    p.mortgage_request_id,
    p.id,
    p.tenant_billing_event_id,
    jsonb_build_object(
      'agent_amount_cents', p.amount_cents,
      'tenant_amount_cents', p.tenant_billing_amount_cents
    )
  FROM live_pay p
  WHERE p.tenant_billing_amount_cents IS NOT NULL
    AND p.tenant_billing_amount_cents <> 0
    AND p.tenant_billing_amount_cents IS DISTINCT FROM p.amount_cents;
$$;

COMMENT ON FUNCTION public.mortgage_agent_compensation_reconciliation(text) IS
  'Flag-only tenant receivable vs agent payable anomalies. A legitimate tenant $0 promotional charge is not an amount mismatch.';

-- ---------------------------------------------------------------------------
-- 10) Roster seed (active) — does not create payables
-- ---------------------------------------------------------------------------
INSERT INTO public.mortgage_agent_accounts (application_user_id, status)
SELECT ur.user_id, 'active'
FROM public.user_roles ur
WHERE ur.role = 'mortgage_agent'
ON CONFLICT (application_user_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 11) RLS / grants — no MHR privilege change
-- ---------------------------------------------------------------------------
ALTER TABLE public.mortgage_agent_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mortgage_agent_compensation_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mortgage_agent_compensation_exclusions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mortgage_agent_compensation_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mortgage_agent_compensation_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mortgage_agent_compensation_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS aws_select_mortgage_agent_accounts ON public.mortgage_agent_accounts;
CREATE POLICY aws_select_mortgage_agent_accounts ON public.mortgage_agent_accounts
  FOR SELECT TO checksops, authenticated
  USING (public.aws_can_admin_mortgage_agent_compensation());

DROP POLICY IF EXISTS aws_select_mortgage_agent_compensation_rates ON public.mortgage_agent_compensation_rates;
CREATE POLICY aws_select_mortgage_agent_compensation_rates ON public.mortgage_agent_compensation_rates
  FOR SELECT TO checksops, authenticated
  USING (public.aws_can_admin_mortgage_agent_compensation());

DROP POLICY IF EXISTS aws_select_mortgage_agent_compensation_exclusions ON public.mortgage_agent_compensation_exclusions;
CREATE POLICY aws_select_mortgage_agent_compensation_exclusions ON public.mortgage_agent_compensation_exclusions
  FOR SELECT TO checksops, authenticated
  USING (public.aws_can_admin_mortgage_agent_compensation());

DROP POLICY IF EXISTS aws_select_mortgage_agent_compensation_entries ON public.mortgage_agent_compensation_entries;
CREATE POLICY aws_select_mortgage_agent_compensation_entries ON public.mortgage_agent_compensation_entries
  FOR SELECT TO checksops, authenticated
  USING (public.aws_can_admin_mortgage_agent_compensation());

DROP POLICY IF EXISTS aws_select_mortgage_agent_compensation_batches ON public.mortgage_agent_compensation_batches;
CREATE POLICY aws_select_mortgage_agent_compensation_batches ON public.mortgage_agent_compensation_batches
  FOR SELECT TO checksops, authenticated
  USING (public.aws_can_admin_mortgage_agent_compensation());

DROP POLICY IF EXISTS aws_select_mortgage_agent_compensation_audit ON public.mortgage_agent_compensation_audit;
CREATE POLICY aws_select_mortgage_agent_compensation_audit ON public.mortgage_agent_compensation_audit
  FOR SELECT TO checksops, authenticated
  USING (public.aws_can_admin_mortgage_agent_compensation());

GRANT SELECT ON TABLE public.mortgage_agent_accounts TO checksops, authenticated;
GRANT SELECT ON TABLE public.mortgage_agent_compensation_rates TO checksops, authenticated;
GRANT SELECT ON TABLE public.mortgage_agent_compensation_exclusions TO checksops, authenticated;
GRANT SELECT ON TABLE public.mortgage_agent_compensation_entries TO checksops, authenticated;
GRANT SELECT ON TABLE public.mortgage_agent_compensation_batches TO checksops, authenticated;
GRANT SELECT ON TABLE public.mortgage_agent_compensation_audit TO checksops, authenticated;

GRANT EXECUTE ON FUNCTION public.aws_is_active_mortgage_agent(uuid) TO checksops, authenticated;
GRANT EXECUTE ON FUNCTION public.aws_can_admin_mortgage_agent_compensation() TO checksops, authenticated;
GRANT EXECUTE ON FUNCTION public.earn_mortgage_agent_compensation(uuid) TO checksops, authenticated;
GRANT EXECUTE ON FUNCTION public.set_mortgage_agent_account_status(uuid, text, text) TO checksops, authenticated;
GRANT EXECUTE ON FUNCTION public.approve_mortgage_agent_compensation(uuid[], text) TO checksops, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_mortgage_agent_compensation_paid(uuid[], date, text, text) TO checksops, authenticated;
GRANT EXECUTE ON FUNCTION public.mortgage_agent_compensation_reconciliation(text) TO checksops, authenticated;
