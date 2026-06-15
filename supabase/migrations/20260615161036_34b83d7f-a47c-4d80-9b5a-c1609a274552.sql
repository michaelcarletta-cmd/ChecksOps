CREATE OR REPLACE FUNCTION public.list_partner_shared_checks(
  _partner_code text,
  _include_shared boolean DEFAULT true,
  _limit integer DEFAULT 200
)
RETURNS TABLE (
  id uuid,
  freedom_claim_id uuid,
  claim_number text,
  carrier text,
  insured_name text,
  check_number text,
  amount numeric,
  status text,
  check_stage check_stage,
  partner_status text,
  partner_status_label text,
  front_image_path text,
  back_image_path text,
  is_shared boolean,
  created_at timestamptz
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH partner_tenant AS (
    SELECT id AS tenant_id
    FROM public.tenants
    WHERE upper(trim(_partner_code)) ~ '^[A-Z0-9]{8}$'
      AND partner_code = upper(trim(_partner_code))
    LIMIT 1
  ),
  owned AS (
    SELECT c.*, false AS is_shared
    FROM public.check_intake_items c
    JOIN partner_tenant pt ON pt.tenant_id = c.tenant_id
  ),
  shared AS (
    SELECT c.*, true AS is_shared
    FROM public.check_intake_items c
    JOIN public.shared_checks s
      ON s.check_id = c.id AND s.revoked_at IS NULL
    JOIN partner_tenant pt ON pt.tenant_id = s.target_tenant_id
    WHERE COALESCE(_include_shared, true) = true
  ),
  combined AS (
    SELECT * FROM owned
    UNION ALL
    SELECT * FROM shared
  ),
  deduped AS (
    SELECT DISTINCT ON (id) *
    FROM combined
    ORDER BY id, is_shared ASC
  )
  SELECT
    d.id,
    d.freedom_claim_id,
    COALESCE(d.freedom_claim_number, d.detected_claim_number) AS claim_number,
    d.carrier_name AS carrier,
    d.payee_line AS insured_name,
    d.check_number,
    d.amount,
    d.status,
    d.check_stage,
    d.partner_status,
    d.partner_status_label,
    d.front_image_path,
    d.back_image_path,
    d.is_shared,
    d.created_at
  FROM deduped d
  ORDER BY d.created_at DESC
  LIMIT GREATEST(1, LEAST(COALESCE(_limit, 200), 500));
$function$;

GRANT EXECUTE ON FUNCTION public.list_partner_shared_checks(text, boolean, integer) TO anon, authenticated, service_role;