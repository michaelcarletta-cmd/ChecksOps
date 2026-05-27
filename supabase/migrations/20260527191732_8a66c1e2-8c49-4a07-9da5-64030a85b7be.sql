-- Fix BYOK encrypt/decrypt: `digest` lives in extensions schema and isn't reachable from
-- the function's search_path. Replace with md5() (built-in core) doubled to derive a
-- 64-char fallback passphrase. This invalidates any previously-stored encrypted keys —
-- since BYOK is brand new and no tenant has saved a key yet, that's acceptable.

CREATE OR REPLACE FUNCTION public.encrypt_tenant_openai_key(p_key text)
RETURNS bytea
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog, extensions
AS $$
DECLARE
  v_pass text;
BEGIN
  v_pass := current_setting('app.openai_creds_passphrase', true);
  IF v_pass IS NULL OR length(v_pass) < 16 THEN
    v_pass := md5('byok-fallback-' || current_database()) || md5('byok-fallback-salt-' || current_database());
  END IF;
  RETURN pgp_sym_encrypt(p_key, v_pass);
END;
$$;

CREATE OR REPLACE FUNCTION public.decrypt_tenant_openai_key(p_tenant uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog, extensions
AS $$
DECLARE
  v_pass text;
  v_enc bytea;
BEGIN
  v_pass := current_setting('app.openai_creds_passphrase', true);
  IF v_pass IS NULL OR length(v_pass) < 16 THEN
    v_pass := md5('byok-fallback-' || current_database()) || md5('byok-fallback-salt-' || current_database());
  END IF;
  SELECT encrypted_key INTO v_enc
    FROM public.tenant_openai_credentials
   WHERE tenant_id = p_tenant;
  IF v_enc IS NULL THEN RETURN NULL; END IF;
  RETURN pgp_sym_decrypt(v_enc, v_pass);
END;
$$;

REVOKE ALL ON FUNCTION public.encrypt_tenant_openai_key(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.decrypt_tenant_openai_key(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.encrypt_tenant_openai_key(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.decrypt_tenant_openai_key(uuid) TO service_role;