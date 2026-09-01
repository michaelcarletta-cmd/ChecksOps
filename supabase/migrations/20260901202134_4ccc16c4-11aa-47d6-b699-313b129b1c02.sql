-- 1. Passkey credentials
CREATE TABLE public.user_passkeys (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  counter BIGINT NOT NULL DEFAULT 0,
  transports TEXT[] NOT NULL DEFAULT '{}',
  device_name TEXT NOT NULL DEFAULT 'Passkey',
  backed_up BOOLEAN NOT NULL DEFAULT false,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_user_passkeys_user ON public.user_passkeys(user_id);

GRANT SELECT, UPDATE, DELETE ON public.user_passkeys TO authenticated;
GRANT ALL ON public.user_passkeys TO service_role;

ALTER TABLE public.user_passkeys ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own passkeys"
  ON public.user_passkeys FOR SELECT TO authenticated
  USING (user_id = auth.uid());
CREATE POLICY "Users rename own passkeys"
  ON public.user_passkeys FOR UPDATE TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "Users delete own passkeys"
  ON public.user_passkeys FOR DELETE TO authenticated
  USING (user_id = auth.uid());

-- 2. Short-lived WebAuthn challenges (backend only)
CREATE TABLE public.webauthn_challenges (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  challenge TEXT NOT NULL,
  email TEXT,
  user_id UUID,
  purpose TEXT NOT NULL,
  consumed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '5 minutes'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_webauthn_challenges_challenge ON public.webauthn_challenges(challenge);

GRANT ALL ON public.webauthn_challenges TO service_role;

ALTER TABLE public.webauthn_challenges ENABLE ROW LEVEL SECURITY;
-- No policies: only the service role (edge functions) may touch this table.

-- 3. Profile auth preferences
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS preferred_auth_method TEXT NOT NULL DEFAULT 'magic_link',
  ADD COLUMN IF NOT EXISTS passkey_enrolled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS totp_enrolled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS password_login_disabled BOOLEAN NOT NULL DEFAULT true;

-- 4. Step-up verification audit
CREATE TABLE public.financial_stepup_log (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  tenant_id UUID,
  action_key TEXT NOT NULL,
  factor_type TEXT NOT NULL DEFAULT 'totp',
  succeeded BOOLEAN NOT NULL DEFAULT true,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_financial_stepup_log_user ON public.financial_stepup_log(user_id);
CREATE INDEX idx_financial_stepup_log_tenant ON public.financial_stepup_log(tenant_id);

GRANT SELECT, INSERT ON public.financial_stepup_log TO authenticated;
GRANT ALL ON public.financial_stepup_log TO service_role;

ALTER TABLE public.financial_stepup_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users record own step-up events"
  ON public.financial_stepup_log FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());
CREATE POLICY "Users view own step-up events"
  ON public.financial_stepup_log FOR SELECT TO authenticated
  USING (user_id = auth.uid());
CREATE POLICY "Tenant admins view tenant step-up events"
  ON public.financial_stepup_log FOR SELECT TO authenticated
  USING (
    tenant_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.tenant_users tu
      WHERE tu.tenant_id = financial_stepup_log.tenant_id
        AND tu.user_id = auth.uid()
    )
    AND public.has_role(auth.uid(), 'admin')
  );

-- 5. updated_at triggers
CREATE OR REPLACE FUNCTION public.set_updated_at_generic()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_user_passkeys_updated_at
  BEFORE UPDATE ON public.user_passkeys
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_generic();

CREATE TRIGGER trg_financial_stepup_log_updated_at
  BEFORE UPDATE ON public.financial_stepup_log
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_generic();

-- 6. Retire password login for all existing accounts
UPDATE public.profiles
SET password_login_disabled = true,
    preferred_auth_method = COALESCE(NULLIF(preferred_auth_method, ''), 'magic_link');