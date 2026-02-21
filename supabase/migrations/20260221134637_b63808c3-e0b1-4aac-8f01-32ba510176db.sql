
-- 1. Phone → User mapping with SMS verification
CREATE TABLE public.user_phone_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  phone_number text NOT NULL,
  is_verified boolean NOT NULL DEFAULT false,
  verification_code text,
  verification_expires_at timestamptz,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(phone_number)
);

ALTER TABLE public.user_phone_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own phone links"
  ON public.user_phone_links FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own phone links"
  ON public.user_phone_links FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own phone links"
  ON public.user_phone_links FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own phone links"
  ON public.user_phone_links FOR DELETE
  USING (auth.uid() = user_id);

-- Service role needs to read all for webhook lookups
CREATE POLICY "Service role can read all phone links"
  ON public.user_phone_links FOR SELECT
  USING (true);

-- 2. Conversation state (which claim is the user talking about via SMS)
CREATE TABLE public.sms_conversation_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  phone_number text NOT NULL,
  active_claim_id uuid REFERENCES public.claims(id) ON DELETE SET NULL,
  last_command text,
  last_response text,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '2 hours'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(phone_number)
);

ALTER TABLE public.sms_conversation_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own conversation state"
  ON public.sms_conversation_state FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Service role full access on conversation state"
  ON public.sms_conversation_state FOR ALL
  USING (true);

-- 3. Darwin SMS activity log
CREATE TABLE public.darwin_sms_activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  phone_number text NOT NULL,
  claim_id uuid REFERENCES public.claims(id) ON DELETE SET NULL,
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  message_text text NOT NULL,
  parsed_intent text,
  darwin_response text,
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processing', 'completed', 'failed', 'needs_context')),
  error_message text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.darwin_sms_activity ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view Darwin SMS activity"
  ON public.darwin_sms_activity FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Service role full access on Darwin SMS activity"
  ON public.darwin_sms_activity FOR ALL
  USING (true);

-- Index for quick phone lookups
CREATE INDEX idx_user_phone_links_phone ON public.user_phone_links(phone_number) WHERE is_verified = true;
CREATE INDEX idx_darwin_sms_activity_claim ON public.darwin_sms_activity(claim_id, created_at DESC);
CREATE INDEX idx_darwin_sms_activity_user ON public.darwin_sms_activity(user_id, created_at DESC);

-- Triggers for updated_at
CREATE TRIGGER update_user_phone_links_updated_at
  BEFORE UPDATE ON public.user_phone_links
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_sms_conversation_state_updated_at
  BEFORE UPDATE ON public.sms_conversation_state
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
