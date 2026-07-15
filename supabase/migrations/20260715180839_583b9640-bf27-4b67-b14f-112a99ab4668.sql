
-- ============================================================================
-- Mortgage agent access scoping
-- Mortgage agents should only see check/claim/loss-draft records tied to an
-- ACTIVE mortgage_handling_requests row (status IN 'requested','in_progress').
-- When the request is completed/cancelled, access is revoked automatically.
--
-- IMPORTANT: users granted 'mortgage_agent' must NOT also hold 'staff' or
-- 'admin' roles, or the broader staff/admin policies override this scoping.
-- ============================================================================

-- Helper: does this check currently have an active mortgage handling request?
CREATE OR REPLACE FUNCTION public.mortgage_agent_can_view_check(_check_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.mortgage_handling_requests r
    WHERE r.check_intake_item_id = _check_id
      AND r.status IN ('requested','in_progress')
  );
$$;

-- Helper: does this claim currently have an active mortgage handling request?
CREATE OR REPLACE FUNCTION public.mortgage_agent_can_view_claim(_claim_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.mortgage_handling_requests r
    WHERE r.claim_id = _claim_id
      AND r.status IN ('requested','in_progress')
  );
$$;

GRANT EXECUTE ON FUNCTION public.mortgage_agent_can_view_check(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mortgage_agent_can_view_claim(uuid) TO authenticated;

-- ============================================================================
-- Scoped SELECT policies for mortgage_agent role
-- ============================================================================

-- check_intake_items
DROP POLICY IF EXISTS "Mortgage agents view checks with active request" ON public.check_intake_items;
CREATE POLICY "Mortgage agents view checks with active request"
ON public.check_intake_items FOR SELECT
TO authenticated
USING (
  has_role(auth.uid(), 'mortgage_agent'::app_role)
  AND public.mortgage_agent_can_view_check(id)
);

-- check_files
DROP POLICY IF EXISTS "Mortgage agents view files for active request checks" ON public.check_files;
CREATE POLICY "Mortgage agents view files for active request checks"
ON public.check_files FOR SELECT
TO authenticated
USING (
  has_role(auth.uid(), 'mortgage_agent'::app_role)
  AND public.mortgage_agent_can_view_check(check_intake_item_id)
);

-- check_payees
DROP POLICY IF EXISTS "Mortgage agents view payees for active request checks" ON public.check_payees;
CREATE POLICY "Mortgage agents view payees for active request checks"
ON public.check_payees FOR SELECT
TO authenticated
USING (
  has_role(auth.uid(), 'mortgage_agent'::app_role)
  AND public.mortgage_agent_can_view_check(check_id)
);

-- check_endorsements
DROP POLICY IF EXISTS "Mortgage agents view endorsements for active request checks" ON public.check_endorsements;
CREATE POLICY "Mortgage agents view endorsements for active request checks"
ON public.check_endorsements FOR SELECT
TO authenticated
USING (
  has_role(auth.uid(), 'mortgage_agent'::app_role)
  AND public.mortgage_agent_can_view_check(check_id)
);

-- check_stakeholders
DROP POLICY IF EXISTS "Mortgage agents view stakeholders for active request checks" ON public.check_stakeholders;
CREATE POLICY "Mortgage agents view stakeholders for active request checks"
ON public.check_stakeholders FOR SELECT
TO authenticated
USING (
  has_role(auth.uid(), 'mortgage_agent'::app_role)
  AND public.mortgage_agent_can_view_check(check_intake_item_id)
);

-- check_messages
DROP POLICY IF EXISTS "Mortgage agents view messages for active request checks" ON public.check_messages;
CREATE POLICY "Mortgage agents view messages for active request checks"
ON public.check_messages FOR SELECT
TO authenticated
USING (
  has_role(auth.uid(), 'mortgage_agent'::app_role)
  AND public.mortgage_agent_can_view_check(check_id)
);

-- check_payment_directions
DROP POLICY IF EXISTS "Mortgage agents view payment directions for active request checks" ON public.check_payment_directions;
CREATE POLICY "Mortgage agents view payment directions for active request checks"
ON public.check_payment_directions FOR SELECT
TO authenticated
USING (
  has_role(auth.uid(), 'mortgage_agent'::app_role)
  AND public.mortgage_agent_can_view_check(check_id)
);

-- claims
DROP POLICY IF EXISTS "Mortgage agents view claims with active request" ON public.claims;
CREATE POLICY "Mortgage agents view claims with active request"
ON public.claims FOR SELECT
TO authenticated
USING (
  has_role(auth.uid(), 'mortgage_agent'::app_role)
  AND public.mortgage_agent_can_view_claim(id)
);

-- claim_files
DROP POLICY IF EXISTS "Mortgage agents view claim files for active request" ON public.claim_files;
CREATE POLICY "Mortgage agents view claim files for active request"
ON public.claim_files FOR SELECT
TO authenticated
USING (
  has_role(auth.uid(), 'mortgage_agent'::app_role)
  AND public.mortgage_agent_can_view_claim(claim_id)
);

-- loss_draft_tracking
DROP POLICY IF EXISTS "Mortgage agents view loss draft tracking for active request" ON public.loss_draft_tracking;
CREATE POLICY "Mortgage agents view loss draft tracking for active request"
ON public.loss_draft_tracking FOR SELECT
TO authenticated
USING (
  has_role(auth.uid(), 'mortgage_agent'::app_role)
  AND (
    public.mortgage_agent_can_view_check(check_intake_item_id)
    OR public.mortgage_agent_can_view_claim(claim_id)
  )
);

-- loss_draft_documents (linked through loss_draft_tracking)
DROP POLICY IF EXISTS "Mortgage agents view loss draft docs for active request" ON public.loss_draft_documents;
CREATE POLICY "Mortgage agents view loss draft docs for active request"
ON public.loss_draft_documents FOR SELECT
TO authenticated
USING (
  has_role(auth.uid(), 'mortgage_agent'::app_role)
  AND EXISTS (
    SELECT 1 FROM public.loss_draft_tracking ldt
    WHERE ldt.id = loss_draft_documents.loss_draft_id
      AND (
        public.mortgage_agent_can_view_check(ldt.check_intake_item_id)
        OR public.mortgage_agent_can_view_claim(ldt.claim_id)
      )
  )
);

-- loss_draft_mortgage_intake (linked through loss_draft_tracking)
DROP POLICY IF EXISTS "Mortgage agents view mortgage intake for active request" ON public.loss_draft_mortgage_intake;
CREATE POLICY "Mortgage agents view mortgage intake for active request"
ON public.loss_draft_mortgage_intake FOR SELECT
TO authenticated
USING (
  has_role(auth.uid(), 'mortgage_agent'::app_role)
  AND EXISTS (
    SELECT 1 FROM public.loss_draft_tracking ldt
    WHERE ldt.id = loss_draft_mortgage_intake.loss_draft_id
      AND (
        public.mortgage_agent_can_view_check(ldt.check_intake_item_id)
        OR public.mortgage_agent_can_view_claim(ldt.claim_id)
      )
  )
);

-- Tighten mortgage_handling_requests reads: agents only see active + their own history
DROP POLICY IF EXISTS "read mortgage handling requests" ON public.mortgage_handling_requests;
CREATE POLICY "read mortgage handling requests"
ON public.mortgage_handling_requests FOR SELECT
TO authenticated
USING (
  has_role(auth.uid(), 'admin'::app_role)
  OR (
    has_role(auth.uid(), 'mortgage_agent'::app_role)
    AND (
      status IN ('requested','in_progress')
      OR assigned_employee_id = auth.uid()
    )
  )
  OR tenant_id IN (SELECT tu.tenant_id FROM tenant_users tu WHERE tu.user_id = auth.uid())
);
