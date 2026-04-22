
-- Add guided mode flag to claims
ALTER TABLE public.claims ADD COLUMN IF NOT EXISTS is_guided_mode boolean NOT NULL DEFAULT false;

-- Add 'guided' to app_role enum if not exists
DO $$ BEGIN
  ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'guided';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Guided claim access: links policyholders to their claims
CREATE TABLE public.guided_claim_access (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  claim_id uuid NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  relationship text NOT NULL DEFAULT 'policyholder',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, claim_id)
);

ALTER TABLE public.guided_claim_access ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Guided users see own access" ON public.guided_claim_access
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff'));

CREATE POLICY "Staff can manage access" ON public.guided_claim_access
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff'))
  WITH CHECK (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff'));

-- Guided communications tracking
CREATE TABLE public.guided_communications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  comm_type text NOT NULL DEFAULT 'email',
  recipient_email text,
  cc_email text,
  subject text,
  body text NOT NULL,
  short_body text,
  status text NOT NULL DEFAULT 'drafted',
  recommended_attachments jsonb DEFAULT '[]'::jsonb,
  actual_attachments jsonb DEFAULT '[]'::jsonb,
  issue_summary text,
  task_type text,
  analysis jsonb,
  sent_to text,
  sent_at timestamptz,
  marked_sent_at timestamptz,
  response_received_at timestamptz,
  response_file_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.guided_communications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Guided users see own comms" ON public.guided_communications
  FOR SELECT TO authenticated
  USING (
    auth.uid() = user_id 
    OR public.has_role(auth.uid(), 'admin') 
    OR public.has_role(auth.uid(), 'staff')
  );

CREATE POLICY "Guided users create own comms" ON public.guided_communications
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Guided users update own comms" ON public.guided_communications
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff'));

-- Guided claim map: Darwin's analysis snapshot for a claim
CREATE TABLE public.guided_claim_map (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE UNIQUE,
  issue_summary text,
  timeline jsonb DEFAULT '[]'::jsonb,
  missing_documents jsonb DEFAULT '[]'::jsonb,
  pressure_points jsonb DEFAULT '[]'::jsonb,
  recommended_next_step text,
  escalation_flags jsonb DEFAULT '[]'::jsonb,
  confidence numeric,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.guided_claim_map ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Guided users see own claim map" ON public.guided_claim_map
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.guided_claim_access gca WHERE gca.claim_id = guided_claim_map.claim_id AND gca.user_id = auth.uid())
    OR public.has_role(auth.uid(), 'admin')
    OR public.has_role(auth.uid(), 'staff')
  );

CREATE POLICY "System can manage claim maps" ON public.guided_claim_map
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff'))
  WITH CHECK (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff'));

-- Allow guided users to see their linked claims
CREATE POLICY "Guided users see linked claims" ON public.claims
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.guided_claim_access gca WHERE gca.claim_id = claims.id AND gca.user_id = auth.uid())
  );

-- Allow guided users to upload files to their linked claims
CREATE POLICY "Guided users upload to linked claims" ON public.claim_files
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.guided_claim_access gca WHERE gca.claim_id = claim_files.claim_id AND gca.user_id = auth.uid())
  );

CREATE POLICY "Guided users see files on linked claims" ON public.claim_files
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.guided_claim_access gca WHERE gca.claim_id = claim_files.claim_id AND gca.user_id = auth.uid())
  );

-- Trigger for updated_at on guided_communications
CREATE TRIGGER update_guided_communications_updated_at
  BEFORE UPDATE ON public.guided_communications
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_guided_claim_map_updated_at
  BEFORE UPDATE ON public.guided_claim_map
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Indexes
CREATE INDEX idx_guided_claim_access_user ON public.guided_claim_access(user_id);
CREATE INDEX idx_guided_claim_access_claim ON public.guided_claim_access(claim_id);
CREATE INDEX idx_guided_communications_claim ON public.guided_communications(claim_id);
CREATE INDEX idx_guided_communications_user ON public.guided_communications(user_id);
CREATE INDEX idx_guided_communications_status ON public.guided_communications(status);
CREATE INDEX idx_claims_guided_mode ON public.claims(is_guided_mode) WHERE is_guided_mode = true;
