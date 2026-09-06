-- Isolated AWS schema parity for Sept 3 payee→endorsement rename
-- and returned-check columns. Does not apply financial grants.
-- Never include preferred_auth_method / user_passkeys.

ALTER TYPE public.check_stage ADD VALUE IF NOT EXISTS 'returned';

ALTER TABLE public.check_intake_items
  ADD COLUMN IF NOT EXISTS returned_at timestamptz,
  ADD COLUMN IF NOT EXISTS return_code text,
  ADD COLUMN IF NOT EXISTS return_reason text,
  ADD COLUMN IF NOT EXISTS return_notes text,
  ADD COLUMN IF NOT EXISTS return_recorded_by uuid,
  ADD COLUMN IF NOT EXISTS return_source text,
  ADD COLUMN IF NOT EXISTS pre_return_stage public.check_stage,
  ADD COLUMN IF NOT EXISTS return_resolved_at timestamptz,
  ADD COLUMN IF NOT EXISTS return_resolution text;

DO $$
BEGIN
  IF to_regclass('public.checkalt_deposits') IS NOT NULL THEN
    ALTER TABLE public.checkalt_deposits
      ADD COLUMN IF NOT EXISTS return_code text,
      ADD COLUMN IF NOT EXISTS return_reason text,
      ADD COLUMN IF NOT EXISTS returned_at timestamptz,
      ADD COLUMN IF NOT EXISTS return_window_until timestamptz;
    CREATE INDEX IF NOT EXISTS idx_checkalt_deposits_return_window
      ON public.checkalt_deposits (return_window_until)
      WHERE return_window_until IS NOT NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_check_intake_returned
  ON public.check_intake_items (tenant_id, returned_at DESC)
  WHERE returned_at IS NOT NULL;

CREATE OR REPLACE FUNCTION public.tg_mirror_payee_to_endorsement()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  v_tenant uuid;
  v_type text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.check_endorsements
    WHERE check_id = OLD.check_id
      AND (payee_id = OLD.id
           OR (payee_id IS NULL AND lower(trim(payee_name)) = lower(trim(OLD.payee_name))))
      AND status NOT IN ('signed','waived');
    RETURN OLD;
  END IF;

  v_tenant := NEW.tenant_id;
  IF v_tenant IS NULL THEN
    SELECT tenant_id INTO v_tenant FROM public.check_intake_items WHERE id = NEW.check_id;
  END IF;

  v_type := public.normalize_endorsement_payee_type(NEW.payee_type);

  -- When a payee is renamed, drop the stale unsigned endorsement row that was
  -- keyed to the previous name so the rename edits (rather than duplicates).
  IF TG_OP = 'UPDATE' AND lower(trim(NEW.payee_name)) IS DISTINCT FROM lower(trim(OLD.payee_name)) THEN
    DELETE FROM public.check_endorsements
    WHERE check_id = NEW.check_id
      AND status NOT IN ('signed','waived')
      AND (payee_id = NEW.id OR payee_id IS NULL)
      AND lower(trim(payee_name)) = lower(trim(OLD.payee_name));
  END IF;

  INSERT INTO public.check_endorsements (
    check_id, tenant_id, payee_id, payee_name, payee_type,
    status, signature_method, contact_email, contact_phone, signed_at
  ) VALUES (
    NEW.check_id, v_tenant, NEW.id, NEW.payee_name, v_type,
    CASE
      WHEN NEW.endorsed_at IS NOT NULL THEN 'signed'
      WHEN NEW.endorsement_status IN ('signed','endorsed','complete','completed') THEN 'signed'
      WHEN NEW.endorsement_status = 'waived' THEN 'waived'
      ELSE 'pending'
    END,
    'portal', NEW.contact_email, NEW.contact_phone, NEW.endorsed_at
  )
  ON CONFLICT (check_id, COALESCE(payee_id, '00000000-0000-0000-0000-000000000000'), lower(trim(payee_name)))
  DO UPDATE SET
    payee_id = EXCLUDED.payee_id,
    payee_type = EXCLUDED.payee_type,
    contact_email = COALESCE(EXCLUDED.contact_email, check_endorsements.contact_email),
    contact_phone = COALESCE(EXCLUDED.contact_phone, check_endorsements.contact_phone),
    status = CASE
      WHEN check_endorsements.status IN ('signed', 'waived') THEN check_endorsements.status
      ELSE EXCLUDED.status
    END,
    signed_at = COALESCE(check_endorsements.signed_at, EXCLUDED.signed_at),
    updated_at = now();

  RETURN NEW;
END;
$function$;

-- Non-financial endorsement / signature write columns required for Class A ports.
-- Does not GRANT platform_fee_line_items or apply 64_financial_activation_grants.sql.

DO $$
BEGIN
  IF to_regclass('public.check_endorsements') IS NOT NULL THEN
    EXECUTE $g$GRANT UPDATE (
      payee_id, tenant_id, payee_name, payee_type, contact_email, contact_phone,
      notes, status, signed_at, token, token_expires_at, signature_image_url,
      signature_method, request_sent_at, last_reminder_at, reminder_count,
      ip_address, user_agent, consent_text, updated_at
    ) ON TABLE public.check_endorsements TO checksops, authenticated$g$;
  END IF;
  IF to_regclass('public.check_payees') IS NOT NULL THEN
    EXECUTE $g$GRANT UPDATE (
      payee_name, payee_type, contact_email, contact_phone, endorsement_status,
      endorsed_at, endorsement_image_path, endorsement_token,
      endorsement_token_expires_at, notification_sent_via, notification_sent_at,
      notification_delivery_status, updated_at
    ) ON TABLE public.check_payees TO checksops, authenticated$g$;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'check_payees'
        AND column_name = 'payment_direction_status'
    ) THEN
      EXECUTE 'GRANT UPDATE (payment_direction_status) ON TABLE public.check_payees TO checksops, authenticated';
    END IF;
  END IF;
  IF to_regclass('public.endorsement_audit_log') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT ON TABLE public.endorsement_audit_log TO checksops, authenticated';
  END IF;
  IF to_regclass('public.endorsement_requests') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT ON TABLE public.endorsement_requests TO checksops, authenticated';
  END IF;
  IF to_regclass('public.check_endorsement_events') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT ON TABLE public.check_endorsement_events TO checksops, authenticated';
  END IF;
  IF to_regclass('public.check_reconciliation_alerts') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT ON TABLE public.check_reconciliation_alerts TO checksops, authenticated';
  END IF;
  IF to_regclass('public.signature_signers') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, UPDATE ON TABLE public.signature_signers TO checksops, authenticated';
  END IF;
  IF to_regclass('public.signature_requests') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, UPDATE ON TABLE public.signature_requests TO checksops, authenticated';
  END IF;
  IF to_regclass('public.signature_fields') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT ON TABLE public.signature_fields TO checksops, authenticated';
  END IF;
  IF to_regclass('public.signature_field_values') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT ON TABLE public.signature_field_values TO checksops, authenticated';
  END IF;
  IF to_regclass('public.esign_event_logs') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT ON TABLE public.esign_event_logs TO checksops, authenticated';
  END IF;
END $$;
