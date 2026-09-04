-- AWS staging: Class A final cleanup grants (OTP upload sessions + SMS audit).
-- Does NOT apply financial activation.

-- Homeowner purpose-scoped upload OTP / sessions
CREATE TABLE IF NOT EXISTS public.homeowner_upload_otp_challenges (
  id uuid PRIMARY KEY,
  email text NOT NULL,
  code_hash text NOT NULL,
  lead_id uuid NULL,
  contractor_profile_id uuid NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.homeowner_upload_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_hash text NOT NULL UNIQUE,
  email text NOT NULL,
  lead_id uuid NULL,
  contractor_profile_id uuid NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS homeowner_upload_otp_email_idx
  ON public.homeowner_upload_otp_challenges (email, created_at DESC);
CREATE INDEX IF NOT EXISTS homeowner_upload_sessions_hash_idx
  ON public.homeowner_upload_sessions (session_hash);

ALTER TABLE public.homeowner_upload_otp_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.homeowner_upload_sessions ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE ON TABLE public.homeowner_upload_otp_challenges TO checksops;
GRANT SELECT, INSERT, UPDATE ON TABLE public.homeowner_upload_sessions TO checksops;

-- SMS audit (best-effort; ignore if table exists with different shape)
DO $$
BEGIN
  IF to_regclass('public.sms_messages') IS NOT NULL THEN
    GRANT SELECT, INSERT ON TABLE public.sms_messages TO checksops;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.aws_public_homeowner_upload_otp_insert(
  p_id uuid,
  p_email text,
  p_code_hash text,
  p_lead_id uuid,
  p_contractor_profile_id uuid,
  p_expires_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  lead_row public.homeowner_intro_requests%ROWTYPE;
BEGIN
  IF p_email IS NULL OR position('@' in p_email) = 0 OR p_code_hash IS NULL THEN
    RETURN jsonb_build_object('error', 'invalid_args');
  END IF;

  IF p_lead_id IS NOT NULL THEN
    SELECT * INTO lead_row FROM public.homeowner_intro_requests WHERE id = p_lead_id LIMIT 1;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('error', 'lead_not_found');
    END IF;
    IF lower(trim(lead_row.homeowner_email)) <> lower(trim(p_email)) THEN
      RETURN jsonb_build_object('error', 'email_mismatch');
    END IF;
  END IF;

  INSERT INTO public.homeowner_upload_otp_challenges (
    id, email, code_hash, lead_id, contractor_profile_id, expires_at, created_at
  ) VALUES (
    p_id, lower(trim(p_email)), p_code_hash, p_lead_id, COALESCE(p_contractor_profile_id, lead_row.contractor_profile_id),
    p_expires_at, now()
  );

  RETURN jsonb_build_object('ok', true, 'id', p_id);
END;
$$;

REVOKE ALL ON FUNCTION public.aws_public_homeowner_upload_otp_insert(uuid, text, text, uuid, uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_public_homeowner_upload_otp_insert(uuid, text, text, uuid, uuid, timestamptz) TO checksops;

CREATE OR REPLACE FUNCTION public.aws_public_homeowner_upload_otp_verify(
  p_email text,
  p_code_hash text,
  p_session_hash text,
  p_session_expires timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  chal public.homeowner_upload_otp_challenges%ROWTYPE;
  lead_json jsonb;
  contractor_json jsonb;
  uploads_json jsonb;
BEGIN
  SELECT * INTO chal
  FROM public.homeowner_upload_otp_challenges
  WHERE email = lower(trim(p_email))
    AND code_hash = p_code_hash
  ORDER BY created_at DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'invalid_code');
  END IF;
  IF chal.used_at IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'used');
  END IF;
  IF chal.expires_at < now() THEN
    RETURN jsonb_build_object('error', 'expired');
  END IF;

  UPDATE public.homeowner_upload_otp_challenges SET used_at = now() WHERE id = chal.id;

  INSERT INTO public.homeowner_upload_sessions (
    session_hash, email, lead_id, contractor_profile_id, expires_at, created_at
  ) VALUES (
    p_session_hash, chal.email, chal.lead_id, chal.contractor_profile_id, p_session_expires, now()
  );

  IF chal.lead_id IS NOT NULL THEN
    SELECT to_jsonb(l) INTO lead_json
    FROM (
      SELECT id, homeowner_name, homeowner_email, property_zip, loss_type, contractor_profile_id
      FROM public.homeowner_intro_requests WHERE id = chal.lead_id
    ) l;
  END IF;

  IF chal.contractor_profile_id IS NOT NULL THEN
    SELECT to_jsonb(c) INTO contractor_json
    FROM (
      SELECT id, display_name, bio, tier
      FROM public.contractor_profiles WHERE id = chal.contractor_profile_id
    ) c;
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(u) ORDER BY u.created_at DESC), '[]'::jsonb)
  INTO uploads_json
  FROM (
    SELECT id, file_path, status, note, created_at
    FROM public.homeowner_check_uploads
    WHERE lower(homeowner_email) = chal.email
    ORDER BY created_at DESC
    LIMIT 20
  ) u;

  RETURN jsonb_build_object(
    'ok', true,
    'email', chal.email,
    'lead_id', chal.lead_id,
    'contractor_profile_id', chal.contractor_profile_id,
    'expires_at', p_session_expires,
    'lead', lead_json,
    'contractor', contractor_json,
    'uploads', uploads_json
  );
END;
$$;

REVOKE ALL ON FUNCTION public.aws_public_homeowner_upload_otp_verify(text, text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_public_homeowner_upload_otp_verify(text, text, text, timestamptz) TO checksops;

CREATE OR REPLACE FUNCTION public.aws_public_homeowner_upload_session_get(p_session_hash text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  sess public.homeowner_upload_sessions%ROWTYPE;
  lead_json jsonb;
  contractor_json jsonb;
  uploads_json jsonb;
BEGIN
  SELECT * INTO sess FROM public.homeowner_upload_sessions WHERE session_hash = p_session_hash LIMIT 1;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'invalid_token'); END IF;
  IF sess.revoked_at IS NOT NULL THEN RETURN jsonb_build_object('error', 'revoked'); END IF;
  IF sess.expires_at < now() THEN RETURN jsonb_build_object('error', 'expired'); END IF;

  IF sess.lead_id IS NOT NULL THEN
    SELECT to_jsonb(l) INTO lead_json
    FROM (
      SELECT id, homeowner_name, homeowner_email, property_zip, loss_type, contractor_profile_id
      FROM public.homeowner_intro_requests WHERE id = sess.lead_id
    ) l;
  END IF;
  IF sess.contractor_profile_id IS NOT NULL THEN
    SELECT to_jsonb(c) INTO contractor_json
    FROM (
      SELECT id, display_name, bio, tier
      FROM public.contractor_profiles WHERE id = sess.contractor_profile_id
    ) c;
  END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(u) ORDER BY u.created_at DESC), '[]'::jsonb)
  INTO uploads_json
  FROM (
    SELECT id, file_path, status, note, created_at
    FROM public.homeowner_check_uploads
    WHERE lower(homeowner_email) = sess.email
    ORDER BY created_at DESC LIMIT 20
  ) u;

  RETURN jsonb_build_object(
    'ok', true,
    'email', sess.email,
    'lead_id', sess.lead_id,
    'contractor_profile_id', sess.contractor_profile_id,
    'lead', lead_json,
    'contractor', contractor_json,
    'uploads', uploads_json
  );
END;
$$;

REVOKE ALL ON FUNCTION public.aws_public_homeowner_upload_session_get(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_public_homeowner_upload_session_get(text) TO checksops;

CREATE OR REPLACE FUNCTION public.aws_public_homeowner_upload_session_revoke(p_session_hash text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.homeowner_upload_sessions
  SET revoked_at = now()
  WHERE session_hash = p_session_hash AND revoked_at IS NULL;
  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.aws_public_homeowner_upload_session_revoke(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_public_homeowner_upload_session_revoke(text) TO checksops;
