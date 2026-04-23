
-- Create shared_checks table for cross-tenant check sharing
CREATE TABLE public.shared_checks (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  check_id UUID NOT NULL REFERENCES public.check_intake_items(id) ON DELETE CASCADE,
  source_tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  target_tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  shared_by UUID NOT NULL,
  access_level TEXT NOT NULL DEFAULT 'read_only',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  revoked_at TIMESTAMP WITH TIME ZONE,
  CONSTRAINT shared_checks_no_self_share CHECK (source_tenant_id != target_tenant_id),
  CONSTRAINT shared_checks_unique_active UNIQUE (check_id, source_tenant_id, target_tenant_id)
);

-- Indexes for fast lookups
CREATE INDEX idx_shared_checks_source ON public.shared_checks(source_tenant_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_shared_checks_target ON public.shared_checks(target_tenant_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_shared_checks_check ON public.shared_checks(check_id);

-- Enable RLS
ALTER TABLE public.shared_checks ENABLE ROW LEVEL SECURITY;

-- Helper: check if user belongs to a tenant
CREATE OR REPLACE FUNCTION public.user_belongs_to_tenant(_user_id uuid, _tenant_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.tenant_users
    WHERE user_id = _user_id AND tenant_id = _tenant_id
  )
$$;

-- Source tenant members can view their outbound shares
CREATE POLICY "Source tenant can view own shares"
ON public.shared_checks FOR SELECT
TO authenticated
USING (public.user_belongs_to_tenant(auth.uid(), source_tenant_id));

-- Target tenant members can view active inbound shares
CREATE POLICY "Target tenant can view active shares"
ON public.shared_checks FOR SELECT
TO authenticated
USING (public.user_belongs_to_tenant(auth.uid(), target_tenant_id) AND revoked_at IS NULL);

-- Source tenant members can create shares
CREATE POLICY "Source tenant can create shares"
ON public.shared_checks FOR INSERT
TO authenticated
WITH CHECK (
  public.user_belongs_to_tenant(auth.uid(), source_tenant_id)
  AND shared_by = auth.uid()
);

-- Source tenant members can update (revoke) shares
CREATE POLICY "Source tenant can update shares"
ON public.shared_checks FOR UPDATE
TO authenticated
USING (public.user_belongs_to_tenant(auth.uid(), source_tenant_id));

-- Source tenant members can delete shares
CREATE POLICY "Source tenant can delete shares"
ON public.shared_checks FOR DELETE
TO authenticated
USING (public.user_belongs_to_tenant(auth.uid(), source_tenant_id));

-- Enable realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.shared_checks;

-- Allow target tenant to read shared check_intake_items via a policy
CREATE POLICY "Target tenant can view shared checks"
ON public.check_intake_items FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.shared_checks sc
    WHERE sc.check_id = id
    AND sc.revoked_at IS NULL
    AND public.user_belongs_to_tenant(auth.uid(), sc.target_tenant_id)
  )
);
