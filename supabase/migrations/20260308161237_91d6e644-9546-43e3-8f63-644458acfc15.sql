
-- Phase 2: Deposit Readiness & Review Console

-- 1. Check review decisions table
CREATE TABLE IF NOT EXISTS public.check_review_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_id uuid NOT NULL REFERENCES public.check_intake_items(id) ON DELETE CASCADE,
  reviewer_id uuid NOT NULL,
  decision text NOT NULL,
  confirmed_carrier_name text,
  confirmed_check_number text,
  confirmed_amount numeric,
  confirmed_payee_line text,
  confirmed_payees jsonb,
  deposit_path text NOT NULL,
  reviewer_notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.check_review_decisions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can manage review decisions"
  ON public.check_review_decisions
  FOR ALL TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff')
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff')
  );

-- 2. Check reissue requests table
CREATE TABLE IF NOT EXISTS public.check_reissue_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_id uuid NOT NULL REFERENCES public.check_intake_items(id) ON DELETE CASCADE,
  requested_by uuid NOT NULL,
  reason text NOT NULL,
  reason_category text NOT NULL DEFAULT 'payee_error',
  notes text,
  status text NOT NULL DEFAULT 'pending',
  resolved_at timestamptz,
  resolved_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.check_reissue_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can manage reissue requests"
  ON public.check_reissue_requests
  FOR ALL TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff')
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff')
  );

-- 3. Add new status values support (status is text, no enum needed)
-- Add index for review queue queries
CREATE INDEX IF NOT EXISTS idx_check_intake_status_review
  ON public.check_intake_items(status)
  WHERE status IN ('needs_review', 'manual_review_required', 'endorsements_complete', 'approved_for_deposit', 'branch_deposit_required', 'reissue_requested');

-- 4. Add reviewer_id to check_intake_items for tracking who approved
ALTER TABLE public.check_intake_items
  ADD COLUMN IF NOT EXISTS reviewed_by uuid,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS review_notes text;
