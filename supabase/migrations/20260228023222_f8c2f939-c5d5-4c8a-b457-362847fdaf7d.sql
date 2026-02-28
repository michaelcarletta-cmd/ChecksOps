
-- Table to track user feedback on autopilot actions for self-tuning confidence
CREATE TABLE public.autopilot_action_feedback (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  claim_id UUID NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL,
  action_summary TEXT NOT NULL,
  confidence TEXT NOT NULL DEFAULT 'medium',
  user_action TEXT NOT NULL CHECK (user_action IN ('done', 'snooze', 'override', 'dismiss')),
  priority_score INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id UUID
);

-- Enable RLS
ALTER TABLE public.autopilot_action_feedback ENABLE ROW LEVEL SECURITY;

-- Staff and admin can insert/read
CREATE POLICY "Staff can manage autopilot feedback"
  ON public.autopilot_action_feedback
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid()
      AND role IN ('admin', 'staff')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid()
      AND role IN ('admin', 'staff')
    )
  );

-- Index for querying feedback patterns
CREATE INDEX idx_autopilot_feedback_action_type ON public.autopilot_action_feedback(action_type, confidence);
CREATE INDEX idx_autopilot_feedback_claim ON public.autopilot_action_feedback(claim_id);
