-- Staging sandbox webhook/financial apply architecture.
-- Does NOT activate AWS_FINANCIAL_PERMISSIONS_ACTIVATED.
-- Does NOT GRANT table-wide INSERT/UPDATE/DELETE on money ledgers to PUBLIC
-- or to a browser role. checksops may EXECUTE only the functions below.
--
-- Apply functions fail closed unless:
--   current_setting('request.provider_webhook_apply') = '1'
-- and they only mutate environment='sandbox' rows (Moov) or isolated
-- aws_provider_sandbox_operations (CheckAlt).
--
-- Production-environment payment_* rows are never updated here.

CREATE OR REPLACE FUNCTION public.aws_sandbox_apply_guard()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('request.provider_webhook_apply', true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'sandbox_financial_apply_denied'
      USING ERRCODE = '42501',
            HINT = 'Set request.provider_webhook_apply=1 from the AWS webhook handler only.';
  END IF;
  IF current_setting('request.aws_financial_permissions_activated', true) = '1' THEN
    RAISE EXCEPTION 'financial_permissions_must_stay_deactivated'
      USING ERRCODE = '42501',
            HINT = 'AWS_FINANCIAL_PERMISSIONS_ACTIVATED must remain false.';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.aws_sandbox_apply_moov_transfer_status(
  p_provider_transfer_id text,
  p_status text,
  p_provider_status text,
  p_failure_reason text,
  p_completed_at timestamptz DEFAULT NULL
) RETURNS TABLE (
  id uuid,
  tenant_id uuid,
  previous_status text,
  new_status text,
  environment text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  old_status text;
BEGIN
  PERFORM public.aws_sandbox_apply_guard();
  SELECT t.status INTO old_status
    FROM public.payment_transfers t
   WHERE t.provider_transfer_id = p_provider_transfer_id
     AND t.environment = 'sandbox'
     AND t.provider = 'moov'
   LIMIT 1;
  RETURN QUERY
  UPDATE public.payment_transfers t
     SET status = p_status,
         provider_status = p_provider_status,
         completed_at = COALESCE(p_completed_at, t.completed_at),
         failure_reason = COALESCE(p_failure_reason, t.failure_reason)
   WHERE t.provider_transfer_id = p_provider_transfer_id
     AND t.environment = 'sandbox'
     AND t.provider = 'moov'
  RETURNING t.id, t.tenant_id, old_status, t.status, t.environment;
END;
$$;

CREATE OR REPLACE FUNCTION public.aws_sandbox_touch_moov_account(
  p_provider_account_id text,
  p_event_type text
) RETURNS TABLE (
  id uuid,
  tenant_id uuid,
  environment text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.aws_sandbox_apply_guard();
  RETURN QUERY
  UPDATE public.payment_provider_accounts a
     SET last_webhook_event_at = now(),
         last_webhook_event_type = p_event_type
   WHERE a.provider = 'moov'
     AND a.provider_account_id = p_provider_account_id
     AND a.environment = 'sandbox'
  RETURNING a.id, a.tenant_id, a.environment;
END;
$$;

CREATE OR REPLACE FUNCTION public.aws_sandbox_apply_checkalt_operation(
  p_reference text,
  p_status text,
  p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS TABLE (
  id uuid,
  tenant_id uuid,
  status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.aws_sandbox_apply_guard();
  RETURN QUERY
  UPDATE public.aws_provider_sandbox_operations o
     SET status = COALESCE(p_status, o.status),
         metadata = o.metadata || COALESCE(p_metadata, '{}'::jsonb),
         updated_at = now()
   WHERE o.provider = 'checkalt'
     AND o.provider_reference = p_reference
     AND o.production_execution = false
  RETURNING o.id, o.tenant_id, o.status;
END;
$$;

REVOKE ALL ON FUNCTION public.aws_sandbox_apply_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_sandbox_apply_moov_transfer_status(text, text, text, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_sandbox_touch_moov_account(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_sandbox_apply_checkalt_operation(text, text, jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.aws_sandbox_apply_guard() TO checksops;
GRANT EXECUTE ON FUNCTION public.aws_sandbox_apply_moov_transfer_status(text, text, text, text, timestamptz) TO checksops;
GRANT EXECUTE ON FUNCTION public.aws_sandbox_touch_moov_account(text, text) TO checksops;
GRANT EXECUTE ON FUNCTION public.aws_sandbox_apply_checkalt_operation(text, text, jsonb) TO checksops;

COMMENT ON FUNCTION public.aws_sandbox_apply_moov_transfer_status(text, text, text, text, timestamptz) IS
  'Sandbox-only Moov transfer status apply. GUC-gated. Never updates environment=production.';
COMMENT ON FUNCTION public.aws_sandbox_apply_checkalt_operation(text, text, jsonb) IS
  'Sandbox-only CheckAlt operation apply. Isolated table. Never writes checkalt_deposits.';
