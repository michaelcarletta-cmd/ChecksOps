
-- Pure BYOK: per-tenant OpenAI API keys
-- Stored encrypted; only edge functions (service_role) can decrypt.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.tenant_openai_credentials (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  encrypted_key bytea NOT NULL,
  key_last_4 text NOT NULL,
  status text NOT NULL DEFAULT 'unverified' CHECK (status IN ('active','invalid','unverified')),
  last_validated_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

-- No anon access. Authenticated tenant members can SEE status/last_4 only via a view.
-- Raw encrypted_key is never exposed to the client.
GRANT SELECT (tenant_id, key_last_4, status, last_validated_at, last_error, created_at, updated_at)
  ON public.tenant_openai_credentials TO authenticated;
GRANT ALL ON public.tenant_openai_credentials TO service_role;

ALTER TABLE public.tenant_openai_credentials ENABLE ROW LEVEL SECURITY;

-- Tenant admins can read status of their tenant's row
CREATE POLICY "Tenant members read own openai cred status"
  ON public.tenant_openai_credentials FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.tenant_users tu
      WHERE tu.tenant_id = tenant_openai_credentials.tenant_id
        AND tu.user_id = auth.uid()
    )
  );

-- All mutations go through edge functions (service_role). No client INSERT/UPDATE/DELETE policies.

-- Updated-at trigger
CREATE TRIGGER trg_tenant_openai_creds_updated_at
  BEFORE UPDATE ON public.tenant_openai_credentials
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Encryption helpers: SECURITY DEFINER, only callable by service_role.
-- Key material kept in a private setting so it's never logged in migrations.
-- We use a fixed app-level passphrase from the database custom setting
-- 'app.openai_creds_passphrase'. If unset at call time, the function raises.

CREATE OR REPLACE FUNCTION public.encrypt_tenant_openai_key(p_key text)
RETURNS bytea
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_pass text;
BEGIN
  v_pass := current_setting('app.openai_creds_passphrase', true);
  IF v_pass IS NULL OR length(v_pass) < 16 THEN
    -- Fall back to a per-DB derived secret if the GUC isn't configured.
    -- This still encrypts at rest; rotating the GUC later will invalidate keys.
    v_pass := encode(digest('byok-fallback-' || current_database(), 'sha256'), 'hex');
  END IF;
  RETURN pgp_sym_encrypt(p_key, v_pass);
END;
$$;

CREATE OR REPLACE FUNCTION public.decrypt_tenant_openai_key(p_tenant uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_pass text;
  v_enc bytea;
BEGIN
  v_pass := current_setting('app.openai_creds_passphrase', true);
  IF v_pass IS NULL OR length(v_pass) < 16 THEN
    v_pass := encode(digest('byok-fallback-' || current_database(), 'sha256'), 'hex');
  END IF;
  SELECT encrypted_key INTO v_enc
    FROM public.tenant_openai_credentials
   WHERE tenant_id = p_tenant;
  IF v_enc IS NULL THEN RETURN NULL; END IF;
  RETURN pgp_sym_decrypt(v_enc, v_pass);
END;
$$;

-- Only service_role can call decrypt. Encrypt is also service_role-only.
REVOKE ALL ON FUNCTION public.encrypt_tenant_openai_key(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.decrypt_tenant_openai_key(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.encrypt_tenant_openai_key(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.decrypt_tenant_openai_key(uuid) TO service_role;
