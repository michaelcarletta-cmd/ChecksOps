-- Staging identity-link helper. Platform owner only. Does not match by email
-- as the identity key. Does not allow cognito_sub = application_user_id.
-- Apply to staging checksops as checksops_admin. Do not apply financial grants.

CREATE OR REPLACE FUNCTION public.link_identity_account(
  p_application_user_id uuid,
  p_cognito_sub text,
  p_email text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  existing_sub public.identity_accounts%ROWTYPE;
  existing_app public.identity_accounts%ROWTYPE;
BEGIN
  IF NOT public.is_master_owner() THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;
  IF p_application_user_id IS NULL OR p_cognito_sub IS NULL OR length(p_cognito_sub) < 8 THEN
    RAISE EXCEPTION 'invalid_identity_link';
  END IF;
  IF p_cognito_sub = p_application_user_id::text THEN
    RAISE EXCEPTION 'cognito_sub_must_not_equal_application_user_id';
  END IF;

  SELECT * INTO existing_sub FROM public.identity_accounts WHERE cognito_sub = p_cognito_sub;
  IF FOUND AND existing_sub.application_user_id IS DISTINCT FROM p_application_user_id THEN
    IF existing_sub.status = 'isolated_test' THEN
      UPDATE public.identity_accounts
      SET cognito_sub = NULL, status = 'pending', linked_at = NULL
      WHERE application_user_id = existing_sub.application_user_id;
    ELSE
      RAISE EXCEPTION 'cognito_sub_already_linked';
    END IF;
  END IF;

  INSERT INTO public.identity_accounts (
    application_user_id, cognito_sub, email, status, linked_at, created_at
  ) VALUES (
    p_application_user_id, p_cognito_sub, p_email, 'active', now(), now()
  )
  ON CONFLICT (application_user_id) DO UPDATE
    SET cognito_sub = EXCLUDED.cognito_sub,
        email = COALESCE(EXCLUDED.email, public.identity_accounts.email),
        status = 'active',
        linked_at = now();

  SELECT * INTO existing_app FROM public.identity_accounts WHERE application_user_id = p_application_user_id;
  RETURN jsonb_build_object(
    'ok', true,
    'application_user_id', existing_app.application_user_id,
    'cognito_sub', existing_app.cognito_sub,
    'status', existing_app.status
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.link_identity_account(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.link_identity_account(uuid, text, text) TO checksops;

COMMENT ON FUNCTION public.link_identity_account(uuid, text, text) IS
  'Explicit Cognito sub → application UUID link. Platform owner only. Never stores sub as the UUID.';
