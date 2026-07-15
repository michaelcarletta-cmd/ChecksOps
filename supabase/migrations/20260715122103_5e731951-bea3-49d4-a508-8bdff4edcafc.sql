
ALTER TABLE public.mortgage_handling_requests
  ADD COLUMN IF NOT EXISTS work_notes TEXT,
  ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

DROP POLICY IF EXISTS "tenant can read own mortgage handling requests" ON public.mortgage_handling_requests;
CREATE POLICY "read mortgage handling requests"
  ON public.mortgage_handling_requests FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR public.has_role(auth.uid(), 'mortgage_agent')
    OR tenant_id IN (
      SELECT tu.tenant_id FROM public.tenant_users tu WHERE tu.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "admins can update all mortgage handling requests" ON public.mortgage_handling_requests;
CREATE POLICY "staff can update all mortgage handling requests"
  ON public.mortgage_handling_requests FOR UPDATE TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR public.has_role(auth.uid(), 'mortgage_agent')
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'admin')
    OR public.has_role(auth.uid(), 'mortgage_agent')
  );

CREATE OR REPLACE FUNCTION public.accept_mortgage_handling_request(_request_id UUID)
RETURNS public.mortgage_handling_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _row public.mortgage_handling_requests;
BEGIN
  IF NOT (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'mortgage_agent')) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  UPDATE public.mortgage_handling_requests
     SET assigned_employee_id = auth.uid(),
         status = 'in_progress',
         accepted_at = COALESCE(accepted_at, now())
   WHERE id = _request_id
     AND assigned_employee_id IS NULL
     AND status = 'requested'
   RETURNING * INTO _row;

  IF _row.id IS NULL THEN
    RAISE EXCEPTION 'already_taken';
  END IF;

  RETURN _row;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_mortgage_handling_request_status(
  _request_id UUID,
  _status TEXT,
  _notes TEXT DEFAULT NULL
)
RETURNS public.mortgage_handling_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _row public.mortgage_handling_requests;
BEGIN
  IF NOT (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'mortgage_agent')) THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  IF _status NOT IN ('in_progress','completed','cancelled') THEN
    RAISE EXCEPTION 'invalid_status';
  END IF;

  UPDATE public.mortgage_handling_requests
     SET status = _status,
         completed_at = CASE WHEN _status = 'completed' THEN now() ELSE completed_at END,
         work_notes = CASE
           WHEN _notes IS NULL OR length(trim(_notes)) = 0 THEN work_notes
           ELSE COALESCE(work_notes || E'\n\n', '') ||
                to_char(now(), 'YYYY-MM-DD HH24:MI') || ' — ' || _notes
         END
   WHERE id = _request_id
     AND (
       assigned_employee_id = auth.uid()
       OR public.has_role(auth.uid(), 'admin')
     )
   RETURNING * INTO _row;

  IF _row.id IS NULL THEN
    RAISE EXCEPTION 'not_assigned_to_you';
  END IF;

  RETURN _row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.accept_mortgage_handling_request(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_mortgage_handling_request_status(UUID, TEXT, TEXT) TO authenticated;
