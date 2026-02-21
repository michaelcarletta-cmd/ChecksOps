
-- Phase 4: Escalation Trigger Rules Table
CREATE TABLE public.escalation_trigger_rules (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  state_code TEXT NOT NULL,
  trigger_category TEXT NOT NULL,
  trigger_name TEXT NOT NULL,
  condition_logic JSONB NOT NULL DEFAULT '{}',
  escalation_strength TEXT NOT NULL,
  regulation_citation TEXT NOT NULL,
  regulation_summary TEXT NOT NULL,
  recommended_action TEXT NOT NULL,
  recommended_artifact TEXT,
  priority_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.escalation_trigger_rules ENABLE ROW LEVEL SECURITY;

-- Rules are read-only for all authenticated users (global reference data)
CREATE POLICY "Authenticated users can read escalation rules"
  ON public.escalation_trigger_rules FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- Only admins can modify
CREATE POLICY "Admins can manage escalation rules"
  ON public.escalation_trigger_rules FOR ALL
  USING (public.has_role(auth.uid(), 'admin'));

-- Index for fast lookup
CREATE INDEX idx_escalation_rules_state ON public.escalation_trigger_rules (state_code, is_active);
CREATE INDEX idx_escalation_rules_category ON public.escalation_trigger_rules (trigger_category);

-- Updated_at trigger
CREATE TRIGGER update_escalation_rules_updated_at
  BEFORE UPDATE ON public.escalation_trigger_rules
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
