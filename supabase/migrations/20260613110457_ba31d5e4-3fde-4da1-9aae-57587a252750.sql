
-- ============ 1. Tenant-level compliance fields ============
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS data_retention_years integer NOT NULL DEFAULT 7,
  ADD COLUMN IF NOT EXISTS wisp_acknowledged_at timestamptz,
  ADD COLUMN IF NOT EXISTS wisp_acknowledged_by uuid,
  ADD COLUMN IF NOT EXISTS qualified_individual_user_id uuid,
  ADD COLUMN IF NOT EXISTS privacy_notice_version text NOT NULL DEFAULT '2026-01';

-- ============ 2. Claim retention timestamp ============
ALTER TABLE public.claims
  ADD COLUMN IF NOT EXISTS retention_purge_after timestamptz;

-- Trigger: when a claim is marked closed, compute retention_purge_after = now() + tenant retention years
CREATE OR REPLACE FUNCTION public.set_claim_retention_purge_after()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_years integer;
BEGIN
  IF NEW.status IN ('closed', 'settled', 'denied', 'archived')
     AND (OLD.status IS DISTINCT FROM NEW.status)
     AND NEW.retention_purge_after IS NULL THEN
    SELECT COALESCE(data_retention_years, 7) INTO v_years
      FROM public.tenants WHERE id = NEW.tenant_id;
    NEW.retention_purge_after := now() + make_interval(years => COALESCE(v_years, 7));
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_set_claim_retention ON public.claims;
CREATE TRIGGER trg_set_claim_retention
  BEFORE UPDATE ON public.claims
  FOR EACH ROW
  EXECUTE FUNCTION public.set_claim_retention_purge_after();

-- ============ 3. Privacy notice acknowledgments ============
CREATE TABLE IF NOT EXISTS public.privacy_notice_acknowledgments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  consumer_email text,
  consumer_name text,
  claim_id uuid,
  user_id uuid,
  notice_version text NOT NULL,
  acknowledged_at timestamptz NOT NULL DEFAULT now(),
  ip_address inet,
  user_agent text,
  delivery_method text NOT NULL DEFAULT 'web',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pna_tenant ON public.privacy_notice_acknowledgments(tenant_id);
CREATE INDEX IF NOT EXISTS idx_pna_claim ON public.privacy_notice_acknowledgments(claim_id);
CREATE INDEX IF NOT EXISTS idx_pna_email ON public.privacy_notice_acknowledgments(consumer_email);

GRANT SELECT, INSERT ON public.privacy_notice_acknowledgments TO authenticated;
GRANT INSERT ON public.privacy_notice_acknowledgments TO anon;
GRANT ALL ON public.privacy_notice_acknowledgments TO service_role;

ALTER TABLE public.privacy_notice_acknowledgments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant members read pna"
  ON public.privacy_notice_acknowledgments
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.tenant_users tu
      WHERE tu.tenant_id = privacy_notice_acknowledgments.tenant_id
        AND tu.user_id = auth.uid()
    )
  );

CREATE POLICY "anon can record acknowledgment"
  ON public.privacy_notice_acknowledgments
  FOR INSERT TO anon
  WITH CHECK (true);

CREATE POLICY "authenticated can record acknowledgment"
  ON public.privacy_notice_acknowledgments
  FOR INSERT TO authenticated
  WITH CHECK (true);

-- ============ 4. GLBA security event log ============
CREATE TABLE IF NOT EXISTS public.glba_security_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid,
  event_type text NOT NULL,
  severity text NOT NULL DEFAULT 'info',
  actor_user_id uuid,
  subject_user_id uuid,
  subject_record_type text,
  subject_record_id uuid,
  description text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_address inet,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_glba_tenant ON public.glba_security_events(tenant_id);
CREATE INDEX IF NOT EXISTS idx_glba_event ON public.glba_security_events(event_type);
CREATE INDEX IF NOT EXISTS idx_glba_created ON public.glba_security_events(created_at DESC);

GRANT SELECT ON public.glba_security_events TO authenticated;
GRANT ALL ON public.glba_security_events TO service_role;

ALTER TABLE public.glba_security_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant admins read glba events"
  ON public.glba_security_events
  FOR SELECT TO authenticated
  USING (
    tenant_id IS NULL OR EXISTS (
      SELECT 1 FROM public.tenant_users tu
      WHERE tu.tenant_id = glba_security_events.tenant_id
        AND tu.user_id = auth.uid()
    )
  );
