
-- 1) Per-row timestamps prevent same-transaction collisions on the audit log idempotency index
ALTER TABLE public.check_audit_log
  ALTER COLUMN created_at SET DEFAULT clock_timestamp();

-- 2) Friendly error wrapper around the review decision RPC
CREATE OR REPLACE FUNCTION public.submit_check_review_decision_safe(
  p_check_id uuid,
  p_reviewer_id uuid,
  p_deposit_path text,
  p_reviewer_notes text DEFAULT NULL,
  p_confirmed_carrier_name text DEFAULT NULL,
  p_confirmed_check_number text DEFAULT NULL,
  p_confirmed_amount numeric DEFAULT NULL,
  p_confirmed_payee_line text DEFAULT NULL,
  p_field_changes jsonb DEFAULT '[]'::jsonb,
  p_reissue_reason text DEFAULT NULL,
  p_reissue_reason_category text DEFAULT 'other',
  p_merge_payees jsonb DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_result jsonb;
  v_constraint text;
  v_friendly text;
BEGIN
  v_result := public.submit_check_review_decision(
    p_check_id, p_reviewer_id, p_deposit_path, p_reviewer_notes,
    p_confirmed_carrier_name, p_confirmed_check_number,
    p_confirmed_amount, p_confirmed_payee_line,
    p_field_changes, p_reissue_reason, p_reissue_reason_category, p_merge_payees
  );
  RETURN v_result;
EXCEPTION
  WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    v_friendly := CASE v_constraint
      WHEN 'idx_loss_draft_claim_servicer' THEN
        'An active loss draft already exists for this claim and mortgage servicer. Open the existing loss draft instead of creating a new one.'
      WHEN 'idx_loss_draft_check_id' THEN
        'This check already has a loss draft record. Open it from the Loss Draft tab.'
      WHEN 'claim_checks_check_intake_item_id_unique' THEN
        'A claim check record already exists for this intake. Refresh the page and try again.'
      WHEN 'check_audit_log_idempotent_key' THEN
        'Duplicate audit event detected. Please refresh and try again — your change may have already been recorded.'
      WHEN 'check_payees_endorsement_token_key' THEN
        'Endorsement token collision while saving. Please try again.'
      ELSE
        'This change conflicts with an existing record (' || COALESCE(v_constraint, 'unknown constraint') || '). Refresh and try again, or contact support if it persists.'
    END;
    RAISE EXCEPTION USING
      MESSAGE = v_friendly,
      ERRCODE = '23505',
      HINT = COALESCE(v_constraint, '');
END;
$$;

GRANT EXECUTE ON FUNCTION public.submit_check_review_decision_safe(
  uuid, uuid, text, text, text, text, numeric, text, jsonb, text, text, jsonb
) TO authenticated, service_role;
