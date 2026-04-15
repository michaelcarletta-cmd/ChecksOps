
CREATE TABLE public.claim_knowledge_library (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  topic TEXT NOT NULL,
  state TEXT,
  trade TEXT,
  material TEXT,
  loss_type TEXT,
  dispute_type TEXT,
  source_type TEXT NOT NULL DEFAULT 'internal',
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  authority_level INTEGER NOT NULL DEFAULT 1,
  tags TEXT[] DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.claim_knowledge_library ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view knowledge entries"
ON public.claim_knowledge_library
FOR SELECT
TO authenticated
USING (true);

CREATE POLICY "Service role can manage knowledge entries"
ON public.claim_knowledge_library
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

CREATE INDEX idx_knowledge_dispute_type ON public.claim_knowledge_library (dispute_type);
CREATE INDEX idx_knowledge_state ON public.claim_knowledge_library (state);
CREATE INDEX idx_knowledge_trade ON public.claim_knowledge_library (trade);
CREATE INDEX idx_knowledge_material ON public.claim_knowledge_library (material);
CREATE INDEX idx_knowledge_loss_type ON public.claim_knowledge_library (loss_type);
CREATE INDEX idx_knowledge_tags ON public.claim_knowledge_library USING GIN (tags);
CREATE INDEX idx_knowledge_authority ON public.claim_knowledge_library (authority_level DESC);
