
-- Drop over-permissive anon policies on check_payment_directions
DROP POLICY IF EXISTS "Anon can view payment directions by token" ON public.check_payment_directions;
DROP POLICY IF EXISTS "Anon can update payment directions by token" ON public.check_payment_directions;

-- Security-definer RPCs replace anon direct table access
CREATE OR REPLACE FUNCTION public.get_payment_direction_by_token(_token uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rec public.check_payment_directions%ROWTYPE;
  chk jsonb;
BEGIN
  SELECT * INTO rec FROM public.check_payment_directions WHERE secure_token = _token;
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF rec.expires_at IS NOT NULL AND rec.expires_at < now() AND rec.request_status = 'pending' THEN
    UPDATE public.check_payment_directions SET request_status = 'expired' WHERE id = rec.id;
    rec.request_status := 'expired';
  END IF;

  SELECT to_jsonb(c) INTO chk FROM (
    SELECT id, claim_id, amount, check_number, endorsement_status,
           payment_direction_status, deposit_status, cleared_status
    FROM public.claim_checks WHERE id = rec.check_id
  ) c;

  RETURN to_jsonb(rec) || jsonb_build_object('claim_checks', chk);
END;
$$;

CREATE OR REPLACE FUNCTION public.submit_payment_direction_by_token(
  _token uuid,
  _decision text,
  _source text DEFAULT 'portal',
  _notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rec public.check_payment_directions%ROWTYPE;
BEGIN
  IF _decision NOT IN ('pay_contractor', 'pay_insured') THEN
    RAISE EXCEPTION 'invalid decision';
  END IF;

  SELECT * INTO rec FROM public.check_payment_directions WHERE secure_token = _token FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not found'; END IF;

  IF rec.expires_at IS NOT NULL AND rec.expires_at < now() THEN
    UPDATE public.check_payment_directions SET request_status = 'expired' WHERE id = rec.id;
    RAISE EXCEPTION 'expired';
  END IF;

  IF rec.request_status <> 'pending' THEN
    RAISE EXCEPTION 'not active';
  END IF;

  UPDATE public.check_payment_directions
     SET request_status = 'answered',
         decision = _decision,
         answered_at = now(),
         answer_source = _source,
         answer_notes = _notes
   WHERE id = rec.id
   RETURNING * INTO rec;

  UPDATE public.claim_checks
     SET payment_direction_status = CASE WHEN _decision = 'pay_contractor' THEN 'pay_contractor' ELSE 'pay_insured' END
   WHERE id = rec.check_id;

  RETURN to_jsonb(rec);
END;
$$;

REVOKE ALL ON FUNCTION public.get_payment_direction_by_token(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.submit_payment_direction_by_token(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_payment_direction_by_token(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_payment_direction_by_token(uuid, text, text, text) TO anon, authenticated;
