-- Narrow mortgage-agent signature send/resend authorization.
-- Staging only. Does not change aws_can_write_tenant.
-- Does not make mortgage agents tenant writers.
--
-- A mortgage_agent may send/resend a signature request ONLY when:
--   * they hold role mortgage_agent
--   * a mortgage_handling_requests row is assigned to them (assigned_employee_id = auth.uid())
--   * that MHR shares claim_id and/or check_intake_item_id with the signature request
--
-- Initiate is the same assignment rule before a request id exists (draft insert).
-- SELECT of signature_requests is aligned to aws_can_access_signature_request so
-- claim-linked rows are visible the same way signers already are. That helper
-- is read-only and already includes mortgage_agent_can_view_*.

CREATE OR REPLACE FUNCTION public.aws_mortgage_agent_assigned_to_context(
  p_claim_id uuid,
  p_check_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT public.has_role(auth.uid(), 'mortgage_agent'::public.app_role)
     AND (
       (p_claim_id IS NOT NULL OR p_check_id IS NOT NULL)
     )
     AND EXISTS (
       SELECT 1
       FROM public.mortgage_handling_requests mhr
       WHERE mhr.assigned_employee_id = auth.uid()
         AND (
           (p_claim_id IS NOT NULL AND mhr.claim_id = p_claim_id)
           OR (p_check_id IS NOT NULL AND mhr.check_intake_item_id = p_check_id)
         )
     );
$$;

COMMENT ON FUNCTION public.aws_mortgage_agent_assigned_to_context(uuid, uuid) IS
  'True when auth.uid() is a mortgage_agent assigned to an MHR that shares this claim or check. Not tenant write.';

CREATE OR REPLACE FUNCTION public.aws_mortgage_agent_can_initiate_signature(
  p_claim_id uuid,
  p_check_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT public.aws_mortgage_agent_assigned_to_context(p_claim_id, p_check_id);
$$;

COMMENT ON FUNCTION public.aws_mortgage_agent_can_initiate_signature(uuid, uuid) IS
  'Draft-insert gate: assigned mortgage agent on the same claim/check context only.';

CREATE OR REPLACE FUNCTION public.aws_mortgage_agent_can_manage_signature(p_request_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT p_request_id IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM public.signature_requests sr
       WHERE sr.id = p_request_id
         AND public.aws_mortgage_agent_assigned_to_context(sr.claim_id, sr.check_intake_item_id)
     );
$$;

COMMENT ON FUNCTION public.aws_mortgage_agent_can_manage_signature(uuid) IS
  'Send/resend gate: assigned mortgage agent and the signature request shares that MHR claim/check.';

REVOKE ALL ON FUNCTION public.aws_mortgage_agent_assigned_to_context(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_mortgage_agent_can_initiate_signature(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_mortgage_agent_can_manage_signature(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_mortgage_agent_assigned_to_context(uuid, uuid) TO checksops, authenticated;
GRANT EXECUTE ON FUNCTION public.aws_mortgage_agent_can_initiate_signature(uuid, uuid) TO checksops, authenticated;
GRANT EXECUTE ON FUNCTION public.aws_mortgage_agent_can_manage_signature(uuid) TO checksops, authenticated;

DROP POLICY IF EXISTS aws_select_signature_requests ON public.signature_requests;
CREATE POLICY aws_select_signature_requests ON public.signature_requests
  FOR SELECT TO authenticated
  USING (public.aws_can_access_signature_request(id));

DROP POLICY IF EXISTS aws_write_signature_requests ON public.signature_requests;
CREATE POLICY aws_write_signature_requests ON public.signature_requests
  FOR ALL TO authenticated
  USING (
    public.aws_can_write_check(check_intake_item_id)
    OR public.aws_can_write_claim(claim_id)
    OR public.aws_mortgage_agent_can_manage_signature(id)
  )
  WITH CHECK (
    public.aws_can_write_check(check_intake_item_id)
    OR public.aws_can_write_claim(claim_id)
    OR public.aws_mortgage_agent_can_initiate_signature(claim_id, check_intake_item_id)
    OR public.aws_mortgage_agent_can_manage_signature(id)
  );

DROP POLICY IF EXISTS aws_write_signature_signers ON public.signature_signers;
CREATE POLICY aws_write_signature_signers ON public.signature_signers
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.signature_requests sr
      WHERE sr.id = signature_signers.signature_request_id
        AND (
          public.aws_can_write_check(sr.check_intake_item_id)
          OR public.aws_can_write_claim(sr.claim_id)
          OR public.aws_mortgage_agent_can_manage_signature(sr.id)
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.signature_requests sr
      WHERE sr.id = signature_signers.signature_request_id
        AND (
          public.aws_can_write_check(sr.check_intake_item_id)
          OR public.aws_can_write_claim(sr.claim_id)
          OR public.aws_mortgage_agent_can_manage_signature(sr.id)
        )
    )
  );

DROP POLICY IF EXISTS aws_write_signature_fields ON public.signature_fields;
CREATE POLICY aws_write_signature_fields ON public.signature_fields
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.signature_requests sr
      WHERE sr.id = signature_fields.signature_request_id
        AND (
          public.aws_can_write_check(sr.check_intake_item_id)
          OR public.aws_can_write_claim(sr.claim_id)
          OR public.aws_mortgage_agent_can_manage_signature(sr.id)
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.signature_requests sr
      WHERE sr.id = signature_fields.signature_request_id
        AND (
          public.aws_can_write_check(sr.check_intake_item_id)
          OR public.aws_can_write_claim(sr.claim_id)
          OR public.aws_mortgage_agent_can_manage_signature(sr.id)
        )
    )
  );

DROP POLICY IF EXISTS aws_write_esign_event_logs ON public.esign_event_logs;
CREATE POLICY aws_write_esign_event_logs ON public.esign_event_logs
  FOR ALL TO authenticated
  USING (
    request_id IS NULL
    OR EXISTS (
      SELECT 1
      FROM public.signature_requests sr
      WHERE sr.id = esign_event_logs.request_id
        AND (
          public.aws_can_write_check(sr.check_intake_item_id)
          OR public.aws_can_write_claim(sr.claim_id)
          OR public.aws_mortgage_agent_can_manage_signature(sr.id)
        )
    )
  )
  WITH CHECK (
    request_id IS NULL
    OR EXISTS (
      SELECT 1
      FROM public.signature_requests sr
      WHERE sr.id = esign_event_logs.request_id
        AND (
          public.aws_can_write_check(sr.check_intake_item_id)
          OR public.aws_can_write_claim(sr.claim_id)
          OR public.aws_mortgage_agent_can_manage_signature(sr.id)
        )
    )
  );
