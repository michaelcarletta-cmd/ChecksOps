CREATE OR REPLACE FUNCTION public.decide_stakeholder_limit_request(
  _request_id uuid,
  _decision text,
  _approved_limit integer,
  _notes text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _req public.stakeholder_limit_requests%ROWTYPE;
  _role text;
  _col text;
BEGIN
  SELECT * INTO _req FROM public.stakeholder_limit_requests WHERE id = _request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF _req.status <> 'pending' THEN RAISE EXCEPTION 'Request already reviewed'; END IF;

  SELECT role INTO _role FROM public.tenant_users
    WHERE tenant_id = _req.tenant_id AND user_id = auth.uid();

  IF _role IS NULL OR _role NOT IN ('owner','admin') THEN
    IF NOT public.has_role(auth.uid(), 'admin'::app_role) THEN
      RAISE EXCEPTION 'Not authorized to decide this request';
    END IF;
  END IF;

  IF _decision NOT IN ('approved','denied') THEN
    RAISE EXCEPTION 'Invalid decision';
  END IF;

  IF _decision = 'approved' THEN
    IF _approved_limit IS NULL OR _approved_limit < 1 THEN
      RAISE EXCEPTION 'Approved limit must be >= 1';
    END IF;
    _col := CASE _req.category
      WHEN 'sales_rep' THEN 'max_sales_reps'
      WHEN 'subcontractor' THEN 'max_subcontractors'
      ELSE NULL END;
    IF _col IS NOT NULL THEN
      EXECUTE format('UPDATE public.tenants SET %I = $1 WHERE id = $2', _col)
        USING _approved_limit, _req.tenant_id;
    END IF;
  END IF;

  UPDATE public.stakeholder_limit_requests
     SET status = _decision,
         reviewed_at = now(),
         reviewed_by = auth.uid(),
         review_notes = _notes,
         requested_limit = CASE WHEN _decision = 'approved' THEN _approved_limit ELSE requested_limit END
   WHERE id = _request_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.decide_stakeholder_limit_request(uuid, text, integer, text) TO authenticated;