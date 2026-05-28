-- 1. Add Freedom claim linking columns to check_intake_items
ALTER TABLE public.check_intake_items
  ADD COLUMN IF NOT EXISTS freedom_claim_id uuid,
  ADD COLUMN IF NOT EXISTS freedom_claim_number text;

CREATE INDEX IF NOT EXISTS idx_check_intake_freedom_claim_id
  ON public.check_intake_items (freedom_claim_id)
  WHERE freedom_claim_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_check_intake_freedom_claim_number
  ON public.check_intake_items (freedom_claim_number)
  WHERE freedom_claim_number IS NOT NULL;

-- 2. Public lookup: list checks for (partner_code, freedom_claim_id).
-- Used by Freedom CRM's iframe / API to mirror status without auth.
-- Safe because results are scoped to a single tenant (resolved by 8-char partner code)
-- AND a single freedom_claim_id supplied by the caller.
CREATE OR REPLACE FUNCTION public.list_checks_by_freedom_claim(
  _partner_code text,
  _freedom_claim_id uuid
)
RETURNS TABLE (
  id uuid,
  check_number text,
  amount numeric,
  carrier_name text,
  payee_line text,
  issue_date date,
  status text,
  check_stage check_stage,
  partner_status text,
  partner_status_label text,
  partner_status_updated_at timestamptz,
  deposit_recommendation text,
  front_image_path text,
  back_image_path text,
  freedom_claim_id uuid,
  freedom_claim_number text,
  detected_claim_number text,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    c.id, c.check_number, c.amount, c.carrier_name, c.payee_line,
    c.issue_date, c.status, c.check_stage, c.partner_status,
    c.partner_status_label, c.partner_status_updated_at,
    c.deposit_recommendation, c.front_image_path, c.back_image_path,
    c.freedom_claim_id, c.freedom_claim_number, c.detected_claim_number,
    c.created_at, c.updated_at
  FROM public.check_intake_items c
  JOIN public.tenants t
    ON t.id = c.tenant_id
  WHERE upper(trim(_partner_code)) ~ '^[A-Z0-9]{8}$'
    AND t.partner_code = upper(trim(_partner_code))
    AND c.freedom_claim_id = _freedom_claim_id
  ORDER BY c.created_at DESC
  LIMIT 500;
$$;

GRANT EXECUTE ON FUNCTION public.list_checks_by_freedom_claim(text, uuid) TO anon, authenticated, service_role;