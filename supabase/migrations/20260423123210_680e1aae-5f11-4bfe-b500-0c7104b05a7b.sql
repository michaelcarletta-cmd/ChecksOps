
-- Tenant partnerships via invite codes
CREATE TABLE public.tenant_partnerships (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  inviter_tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  invitee_tenant_id UUID REFERENCES public.tenants(id) ON DELETE CASCADE,
  invite_code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  created_by UUID NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  accepted_at TIMESTAMP WITH TIME ZONE,
  revoked_at TIMESTAMP WITH TIME ZONE,
  CONSTRAINT partnership_no_self CHECK (inviter_tenant_id != invitee_tenant_id)
);

CREATE INDEX idx_partnerships_invite_code ON public.tenant_partnerships(invite_code) WHERE status = 'pending';
CREATE INDEX idx_partnerships_inviter ON public.tenant_partnerships(inviter_tenant_id) WHERE status = 'active';
CREATE INDEX idx_partnerships_invitee ON public.tenant_partnerships(invitee_tenant_id) WHERE status = 'active';

ALTER TABLE public.tenant_partnerships ENABLE ROW LEVEL SECURITY;

-- Members of either side can view
CREATE POLICY "Partners can view own partnerships"
ON public.tenant_partnerships FOR SELECT
TO authenticated
USING (
  public.user_belongs_to_tenant(auth.uid(), inviter_tenant_id)
  OR (invitee_tenant_id IS NOT NULL AND public.user_belongs_to_tenant(auth.uid(), invitee_tenant_id))
);

-- Inviter tenant members can create invites
CREATE POLICY "Inviter can create partnerships"
ON public.tenant_partnerships FOR INSERT
TO authenticated
WITH CHECK (
  public.user_belongs_to_tenant(auth.uid(), inviter_tenant_id)
  AND created_by = auth.uid()
);

-- Either side can update (accept/revoke)
CREATE POLICY "Partners can update partnerships"
ON public.tenant_partnerships FOR UPDATE
TO authenticated
USING (
  public.user_belongs_to_tenant(auth.uid(), inviter_tenant_id)
  OR (invitee_tenant_id IS NOT NULL AND public.user_belongs_to_tenant(auth.uid(), invitee_tenant_id))
);

-- Anyone authenticated can look up a pending invite code to redeem it
CREATE POLICY "Anyone can lookup pending invites"
ON public.tenant_partnerships FOR SELECT
TO authenticated
USING (status = 'pending' AND invitee_tenant_id IS NULL);
