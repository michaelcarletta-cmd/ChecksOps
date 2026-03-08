
-- Check if types already exist from partial first migration
DO $$ BEGIN
  CREATE TYPE public.deposit_provider AS ENUM ('manual_branch','internal_ready','synctera','treasury_prime');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE public.deposit_item_status AS ENUM ('pending_assignment','provider_assigned','submitted','processing','succeeded','failed','returned','reconciled','exception');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE public.deposit_batch_status AS ENUM ('open','sealed','submitted','partially_cleared','cleared','exception');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Tables (IF NOT EXISTS for safety)
CREATE TABLE IF NOT EXISTS public.deposit_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_number text NOT NULL DEFAULT ('BATCH-' || to_char(now(), 'YYYYMMDD-HH24MISS') || '-' || substr(gen_random_uuid()::text, 1, 4)),
  provider deposit_provider NOT NULL,
  status deposit_batch_status NOT NULL DEFAULT 'open',
  total_items integer NOT NULL DEFAULT 0,
  total_amount numeric(12,2) NOT NULL DEFAULT 0,
  cleared_amount numeric(12,2) NOT NULL DEFAULT 0,
  failed_amount numeric(12,2) NOT NULL DEFAULT 0,
  submitted_at timestamptz,
  cleared_at timestamptz,
  created_by uuid REFERENCES auth.users(id),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.deposit_batches ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Staff can manage deposit batches" ON public.deposit_batches;
CREATE POLICY "Staff can manage deposit batches" ON public.deposit_batches FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'admin'));

CREATE TABLE IF NOT EXISTS public.deposit_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_id uuid NOT NULL REFERENCES public.check_intake_items(id),
  batch_id uuid REFERENCES public.deposit_batches(id),
  provider deposit_provider,
  status deposit_item_status NOT NULL DEFAULT 'pending_assignment',
  amount numeric(12,2) NOT NULL,
  check_number text,
  carrier_name text,
  claim_id uuid,
  idempotency_key text NOT NULL DEFAULT gen_random_uuid()::text,
  provider_reference text,
  provider_payload jsonb,
  provider_response jsonb,
  exception_reason text,
  exception_code text,
  reconciled_amount numeric(12,2),
  reconciled_at timestamptz,
  reconciled_by uuid,
  submitted_at timestamptz,
  cleared_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(check_id)
);
ALTER TABLE public.deposit_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Staff can manage deposit items" ON public.deposit_items;
CREATE POLICY "Staff can manage deposit items" ON public.deposit_items FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'admin'));

CREATE TABLE IF NOT EXISTS public.deposit_provider_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deposit_item_id uuid NOT NULL REFERENCES public.deposit_items(id),
  provider deposit_provider NOT NULL,
  attempt_number integer NOT NULL DEFAULT 1,
  idempotency_key text NOT NULL,
  request_payload jsonb,
  response_payload jsonb,
  response_code integer,
  status text NOT NULL DEFAULT 'pending',
  error_message text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.deposit_provider_attempts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Staff can view provider attempts" ON public.deposit_provider_attempts;
CREATE POLICY "Staff can view provider attempts" ON public.deposit_provider_attempts FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'admin'));

CREATE TABLE IF NOT EXISTS public.deposit_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deposit_item_id uuid NOT NULL REFERENCES public.deposit_items(id),
  exception_type text NOT NULL,
  exception_code text,
  description text NOT NULL,
  provider deposit_provider,
  severity text NOT NULL DEFAULT 'warning',
  resolved_at timestamptz,
  resolved_by uuid,
  resolution_notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.deposit_exceptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Staff can manage exceptions" ON public.deposit_exceptions;
CREATE POLICY "Staff can manage exceptions" ON public.deposit_exceptions FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'admin'));

CREATE TABLE IF NOT EXISTS public.deposit_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider deposit_provider NOT NULL,
  event_type text NOT NULL,
  event_id text,
  idempotency_key text,
  payload jsonb NOT NULL DEFAULT '{}',
  deposit_item_id uuid REFERENCES public.deposit_items(id),
  processed boolean NOT NULL DEFAULT false,
  processed_at timestamptz,
  replay_of uuid REFERENCES public.deposit_webhook_events(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider, event_id)
);
ALTER TABLE public.deposit_webhook_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Staff can view webhook events" ON public.deposit_webhook_events;
CREATE POLICY "Staff can view webhook events" ON public.deposit_webhook_events FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'admin'));

CREATE TABLE IF NOT EXISTS public.deposit_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deposit_item_id uuid REFERENCES public.deposit_items(id),
  batch_id uuid REFERENCES public.deposit_batches(id),
  action text NOT NULL,
  actor_id uuid,
  old_values jsonb,
  new_values jsonb,
  amount numeric(12,2),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.deposit_audit_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Staff can view deposit audit" ON public.deposit_audit_log;
CREATE POLICY "Staff can view deposit audit" ON public.deposit_audit_log FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'admin'));
