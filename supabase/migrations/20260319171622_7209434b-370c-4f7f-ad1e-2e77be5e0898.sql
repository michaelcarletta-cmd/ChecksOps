
-- 1. Add tracking fields to claim_checks (deposit_status already exists)
ALTER TABLE public.claim_checks
ADD COLUMN IF NOT EXISTS endorsement_status text DEFAULT 'pending',
ADD COLUMN IF NOT EXISTS payment_direction_status text DEFAULT 'not_requested',
ADD COLUMN IF NOT EXISTS cleared_status text DEFAULT 'pending';

-- 2. Payment direction request table
CREATE TABLE IF NOT EXISTS public.check_payment_directions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL,
  check_id uuid NOT NULL REFERENCES public.claim_checks(id) ON DELETE CASCADE,
  request_status text NOT NULL DEFAULT 'pending',
  decision text,
  contractor_name text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz,
  expires_at timestamptz,
  answer_source text,
  answer_notes text,
  secure_token uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_check_payment_directions_claim_id
  ON public.check_payment_directions(claim_id);

CREATE INDEX IF NOT EXISTS idx_check_payment_directions_check_id
  ON public.check_payment_directions(check_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_check_payment_directions_secure_token
  ON public.check_payment_directions(secure_token);

-- 3. Disbursements table
CREATE TABLE IF NOT EXISTS public.claim_disbursements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL,
  check_id uuid NOT NULL REFERENCES public.claim_checks(id) ON DELETE CASCADE,
  payment_direction_id uuid REFERENCES public.check_payment_directions(id) ON DELETE SET NULL,
  recipient_type text NOT NULL,
  recipient_name text,
  amount numeric(12,2),
  method text DEFAULT 'manual',
  status text NOT NULL DEFAULT 'draft',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_claim_disbursements_claim_id
  ON public.claim_disbursements(claim_id);

CREATE INDEX IF NOT EXISTS idx_claim_disbursements_check_id
  ON public.claim_disbursements(check_id);

-- 4. updated_at trigger helper
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_check_payment_directions_updated_at ON public.check_payment_directions;
CREATE TRIGGER trg_check_payment_directions_updated_at
BEFORE UPDATE ON public.check_payment_directions
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_claim_disbursements_updated_at ON public.claim_disbursements;
CREATE TRIGGER trg_claim_disbursements_updated_at
BEFORE UPDATE ON public.claim_disbursements
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

-- 5. RLS policies
ALTER TABLE public.check_payment_directions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claim_disbursements ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view payment directions"
ON public.check_payment_directions FOR SELECT TO authenticated
USING (true);

CREATE POLICY "Authenticated users can insert payment directions"
ON public.check_payment_directions FOR INSERT TO authenticated
WITH CHECK (true);

CREATE POLICY "Authenticated users can update payment directions"
ON public.check_payment_directions FOR UPDATE TO authenticated
USING (true);

CREATE POLICY "Anon can view payment directions by token"
ON public.check_payment_directions FOR SELECT TO anon
USING (true);

CREATE POLICY "Anon can update payment directions by token"
ON public.check_payment_directions FOR UPDATE TO anon
USING (true);

CREATE POLICY "Authenticated users can view disbursements"
ON public.claim_disbursements FOR SELECT TO authenticated
USING (true);

CREATE POLICY "Authenticated users can insert disbursements"
ON public.claim_disbursements FOR INSERT TO authenticated
WITH CHECK (true);

CREATE POLICY "Authenticated users can update disbursements"
ON public.claim_disbursements FOR UPDATE TO authenticated
USING (true);
