CREATE OR REPLACE FUNCTION public.vault_create_bridge_secret(_secret text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
DECLARE v_id uuid;
BEGIN
  SELECT vault.create_secret(_secret, 'CROSS_APP_BRIDGE_SECRET', 'Cross-app bridge secret used by sync_partner_check_status_change trigger') INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.vault_update_bridge_secret(_secret text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
DECLARE v_id uuid;
BEGIN
  SELECT id INTO v_id FROM vault.secrets WHERE name = 'CROSS_APP_BRIDGE_SECRET' LIMIT 1;
  IF v_id IS NULL THEN
    PERFORM vault.create_secret(_secret, 'CROSS_APP_BRIDGE_SECRET', 'Cross-app bridge secret');
  ELSE
    PERFORM vault.update_secret(v_id, _secret, 'CROSS_APP_BRIDGE_SECRET', 'Cross-app bridge secret');
  END IF;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.vault_create_bridge_secret(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.vault_update_bridge_secret(text) FROM PUBLIC, anon, authenticated;