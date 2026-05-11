CREATE OR REPLACE FUNCTION public.normalize_partner_check_status(
  _status text,
  _check_stage public.check_stage
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $function$
BEGIN
  IF _check_stage = 'deposited' THEN
    RETURN 'deposited';
  ELSIF _check_stage = 'ready_for_deposit' THEN
    IF _status = 'branch_deposit_required' THEN
      RETURN 'branch_deposit_required';
    END IF;
    RETURN 'approved_for_deposit';
  ELSIF _check_stage = 'endorsing' THEN
    RETURN 'endorsements_in_progress';
  ELSIF _check_stage = 'loss_draft' THEN
    RETURN 'loss_draft_required';
  END IF;

  IF _status = 'reissue_requested' THEN
    RETURN 'reissue_requested';
  ELSIF _status IN ('manual_review_required', 'endorsements_complete', 'uploaded') THEN
    RETURN _status;
  ELSIF _status IS NULL OR btrim(_status) = '' THEN
    RETURN 'needs_review';
  END IF;

  RETURN _status;
END;
$function$;

CREATE OR REPLACE FUNCTION public.sync_partner_check_status_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_source_project_ref text;
  v_source_check_id text;
  v_bridge_secret text;
  v_sync_url text;
  v_status text;
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RETURN NEW;
  END IF;

  IF NEW.external_origin IS NULL THEN
    RETURN NEW;
  END IF;

  v_source_project_ref := NULLIF(btrim(NEW.external_origin->>'source_project_ref'), '');
  v_source_check_id := NULLIF(btrim(NEW.external_origin->>'source_check_id'), '');

  IF v_source_project_ref IS NULL OR v_source_check_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.check_stage IS NOT DISTINCT FROM OLD.check_stage
     AND NEW.deposit_recommendation IS NOT DISTINCT FROM OLD.deposit_recommendation
     AND NEW.ocr_status IS NOT DISTINCT FROM OLD.ocr_status THEN
    RETURN NEW;
  END IF;

  v_bridge_secret := (
    SELECT decrypted_secret
    FROM vault.decrypted_secrets
    WHERE name = 'CROSS_APP_BRIDGE_SECRET'
    LIMIT 1
  );

  IF v_bridge_secret IS NULL OR btrim(v_bridge_secret) = '' THEN
    INSERT INTO public.check_audit_log (
      check_id,
      tenant_id,
      event_type,
      event_description,
      event_data
    ) VALUES (
      NEW.id,
      NEW.tenant_id,
      'partner_status_sync_failed',
      'Skipped partner status sync because bridge secret is not configured.',
      jsonb_build_object(
        'source_project_ref', v_source_project_ref,
        'source_check_id', v_source_check_id,
        'status', NEW.status,
        'check_stage', NEW.check_stage,
        'deposit_recommendation', NEW.deposit_recommendation,
        'ocr_status', NEW.ocr_status
      )
    );
    RETURN NEW;
  END IF;

  v_status := public.normalize_partner_check_status(NEW.status, NEW.check_stage);
  v_sync_url := format('https://%s.supabase.co/functions/v1/sync-check-status', v_source_project_ref);

  PERFORM net.http_post(
    url := v_sync_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-bridge-secret', v_bridge_secret
    ),
    body := jsonb_build_object(
      'source_check_id', v_source_check_id,
      'status', v_status,
      'deposit_recommendation', NEW.deposit_recommendation,
      'ocr_status', NEW.ocr_status,
      'check_stage', NEW.check_stage
    )
  );

  INSERT INTO public.check_audit_log (
    check_id,
    tenant_id,
    event_type,
    event_description,
    event_data
  ) VALUES (
    NEW.id,
    NEW.tenant_id,
    'partner_status_sync_queued',
    'Queued partner status sync for the source app.',
    jsonb_build_object(
      'source_project_ref', v_source_project_ref,
      'source_check_id', v_source_check_id,
      'sync_url', v_sync_url,
      'status', v_status,
      'check_stage', NEW.check_stage,
      'deposit_recommendation', NEW.deposit_recommendation,
      'ocr_status', NEW.ocr_status
    )
  );

  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    INSERT INTO public.check_audit_log (
      check_id,
      tenant_id,
      event_type,
      event_description,
      event_data
    ) VALUES (
      NEW.id,
      NEW.tenant_id,
      'partner_status_sync_failed',
      'Partner status sync failed while queueing the outbound request.',
      jsonb_build_object(
        'source_project_ref', v_source_project_ref,
        'source_check_id', v_source_check_id,
        'error', SQLERRM,
        'status', NEW.status,
        'check_stage', NEW.check_stage,
        'deposit_recommendation', NEW.deposit_recommendation,
        'ocr_status', NEW.ocr_status
      )
    );
    RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_sync_partner_check_status_change ON public.check_intake_items;

CREATE TRIGGER trg_sync_partner_check_status_change
AFTER UPDATE OF status, check_stage, deposit_recommendation, ocr_status
ON public.check_intake_items
FOR EACH ROW
EXECUTE FUNCTION public.sync_partner_check_status_change();