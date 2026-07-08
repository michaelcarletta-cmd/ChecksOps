-- Wrapper so an Edge Function (using its own service-role credentials) can
-- store/update a vault secret via supabase.rpc(). Vault functions live in
-- the `vault` schema, which PostgREST doesn't expose directly.
--
-- Restricted to service_role only — never granted to `authenticated` or
-- `anon` — since this can write arbitrary secrets into vault.
CREATE OR REPLACE FUNCTION public.set_vault_secret(secret_name TEXT, secret_value TEXT)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM vault.secrets WHERE name = secret_name) THEN
    PERFORM vault.update_secret(
      (SELECT id FROM vault.secrets WHERE name = secret_name),
      secret_value
    );
  ELSE
    PERFORM vault.create_secret(secret_value, secret_name);
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.set_vault_secret(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_vault_secret(TEXT, TEXT) FROM authenticated;
REVOKE ALL ON FUNCTION public.set_vault_secret(TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.set_vault_secret(TEXT, TEXT) TO service_role;
