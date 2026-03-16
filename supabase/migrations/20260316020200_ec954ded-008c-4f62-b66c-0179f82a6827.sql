
CREATE TABLE IF NOT EXISTS public.darwin_declared_position_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL,
  user_id uuid NULL,
  action text NOT NULL,
  before_json jsonb NULL,
  after_json jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.darwin_declared_position_audit_logs ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_dp_audit_claim_id ON public.darwin_declared_position_audit_logs (claim_id);
CREATE INDEX IF NOT EXISTS idx_dp_audit_created_at ON public.darwin_declared_position_audit_logs (created_at DESC);

CREATE POLICY "Authenticated users can insert audit logs"
  ON public.darwin_declared_position_audit_logs
  FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can read audit logs"
  ON public.darwin_declared_position_audit_logs
  FOR SELECT
  TO authenticated
  USING (true);
