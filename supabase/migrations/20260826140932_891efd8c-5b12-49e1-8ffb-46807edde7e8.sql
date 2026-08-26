CREATE OR REPLACE FUNCTION public.user_can_access_claim(_user_id uuid, _claim_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT _user_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.claims cl
    WHERE cl.id = _claim_id
      AND (
        public.is_tenant_member(_user_id, cl.org_id)
        OR EXISTS (
          SELECT 1 FROM public.claim_contractors cc
          WHERE cc.claim_id = cl.id AND cc.contractor_id = _user_id
        )
        OR (public.has_role(_user_id, 'mortgage_agent'::public.app_role) AND public.mortgage_agent_can_view_claim(cl.id))
        OR public.current_tenant_is_claim_funds_recipient(cl.id)
      )
  );
$$;

DROP TRIGGER IF EXISTS trg_enqueue_jobnimbus_file_sync ON public.claim_files;
DROP TRIGGER IF EXISTS trigger_jobnimbus_file_sync ON public.claim_files;
DROP TRIGGER IF EXISTS trigger_jobnimbus_claim_sync ON public.claims;

DROP FUNCTION IF EXISTS public.enqueue_jobnimbus_file_sync() CASCADE;
DROP FUNCTION IF EXISTS public.queue_jobnimbus_file_sync() CASCADE;
DROP FUNCTION IF EXISTS public.queue_jobnimbus_claim_sync() CASCADE;
DROP FUNCTION IF EXISTS public.queue_jobnimbus_inspection_sync() CASCADE;
DROP FUNCTION IF EXISTS public.queue_jobnimbus_note_sync() CASCADE;
DROP FUNCTION IF EXISTS public.queue_jobnimbus_sync() CASCADE;
DROP FUNCTION IF EXISTS public.has_workspace_access(uuid, uuid) CASCADE;
DROP FUNCTION IF EXISTS public.is_org_admin(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.is_org_member(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.user_org_id() CASCADE;
DROP FUNCTION IF EXISTS public.set_claim_org_id() CASCADE;