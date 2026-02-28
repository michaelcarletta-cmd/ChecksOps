
-- Create claim_master_state as single source of truth for Darwin cockpit
CREATE TABLE public.claim_master_state (
  claim_id UUID NOT NULL PRIMARY KEY REFERENCES public.claims(id) ON DELETE CASCADE,
  state_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.claim_master_state ENABLE ROW LEVEL SECURITY;

-- Staff/admin can read/write
CREATE POLICY "Staff can view claim master state"
  ON public.claim_master_state FOR SELECT
  USING (
    public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff')
  );

CREATE POLICY "Staff can insert claim master state"
  ON public.claim_master_state FOR INSERT
  WITH CHECK (
    public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff')
  );

CREATE POLICY "Staff can update claim master state"
  ON public.claim_master_state FOR UPDATE
  USING (
    public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff')
  );

-- Allow edge functions (service role) full access is implicit
-- Enable realtime for instant UI updates
ALTER PUBLICATION supabase_realtime ADD TABLE public.claim_master_state;

-- Index for fast lookups
CREATE INDEX idx_claim_master_state_updated ON public.claim_master_state(updated_at DESC);
