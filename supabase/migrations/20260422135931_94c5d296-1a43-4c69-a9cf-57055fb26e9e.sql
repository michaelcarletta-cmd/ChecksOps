
-- Tenant-scoped dashboard counts
CREATE OR REPLACE FUNCTION public.get_check_dashboard_counts_for_tenant(_tenant_id UUID)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE result jsonb;
BEGIN
  -- Allow system admins or tenant members
  IF NOT public.has_role(auth.uid(), 'admin') 
     AND NOT public.has_role(auth.uid(), 'staff')
     AND NOT public.is_tenant_member(auth.uid(), _tenant_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT jsonb_build_object(
    'manual_review', COUNT(*) FILTER (WHERE status IN ('needs_review','manual_review_required','endorsements_complete') OR ocr_status = 'failed'),
    'branch_deposit', COUNT(*) FILTER (WHERE status = 'branch_deposit_required'),
    'reissue_requested', COUNT(*) FILTER (WHERE status = 'reissue_requested'),
    'approved_for_deposit', COUNT(*) FILTER (WHERE status = 'approved_for_deposit'),
    'total_deposited', COUNT(*) FILTER (WHERE status = 'deposited'),
    'total_deposited_value', COALESCE(SUM(amount) FILTER (WHERE status = 'deposited'), 0),
    'total_checks', COUNT(*)
  ) INTO result
  FROM check_intake_items
  WHERE tenant_id = _tenant_id;

  RETURN COALESCE(result, '{}'::jsonb);
END;
$$;
