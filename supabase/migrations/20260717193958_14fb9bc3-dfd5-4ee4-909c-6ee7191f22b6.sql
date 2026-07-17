CREATE OR REPLACE FUNCTION public.resolve_homeowner_ledger_context(
  p_claim_id uuid DEFAULT NULL,
  p_check_intake_item_id uuid DEFAULT NULL,
  p_loss_draft_id uuid DEFAULT NULL
)
RETURNS TABLE(resolved_claim_id uuid, resolved_tenant_id uuid, resolved_check_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  RETURN QUERY
  WITH candidates AS (
    SELECT
      cii.claim_id AS claim_id,
      cii.tenant_id AS tenant_id,
      cii.id AS check_id,
      1 AS priority,
      cii.created_at AS sort_at
    FROM public.check_intake_items cii
    WHERE p_check_intake_item_id IS NOT NULL
      AND cii.id = p_check_intake_item_id
      AND cii.tenant_id IS NOT NULL

    UNION ALL

    SELECT
      cii.claim_id AS claim_id,
      cii.tenant_id AS tenant_id,
      cii.id AS check_id,
      2 AS priority,
      cii.created_at AS sort_at
    FROM public.loss_draft_tracking ldt
    JOIN public.check_intake_items cii ON cii.id = ldt.check_intake_item_id
    WHERE p_loss_draft_id IS NOT NULL
      AND ldt.id = p_loss_draft_id
      AND cii.tenant_id IS NOT NULL

    UNION ALL

    SELECT
      cii.claim_id AS claim_id,
      cii.tenant_id AS tenant_id,
      cii.id AS check_id,
      3 AS priority,
      cii.created_at AS sort_at
    FROM public.check_intake_items cii
    WHERE p_claim_id IS NOT NULL
      AND cii.claim_id = p_claim_id
      AND cii.tenant_id IS NOT NULL

    UNION ALL

    SELECT
      mhr.claim_id AS claim_id,
      mhr.tenant_id AS tenant_id,
      mhr.check_intake_item_id AS check_id,
      4 AS priority,
      mhr.created_at AS sort_at
    FROM public.mortgage_handling_requests mhr
    WHERE mhr.tenant_id IS NOT NULL
      AND (
        (p_claim_id IS NOT NULL AND mhr.claim_id = p_claim_id)
        OR (p_check_intake_item_id IS NOT NULL AND mhr.check_intake_item_id = p_check_intake_item_id)
      )

    UNION ALL

    SELECT
      hlt.claim_id AS claim_id,
      hlt.tenant_id AS tenant_id,
      NULL::uuid AS check_id,
      5 AS priority,
      hlt.created_at AS sort_at
    FROM public.homeowner_ledger_tokens hlt
    WHERE p_claim_id IS NOT NULL
      AND hlt.claim_id = p_claim_id
      AND hlt.tenant_id IS NOT NULL
  )
  SELECT
    COALESCE(c.claim_id, p_claim_id) AS resolved_claim_id,
    c.tenant_id AS resolved_tenant_id,
    COALESCE(c.check_id, p_check_intake_item_id) AS resolved_check_id
  FROM candidates c
  ORDER BY c.priority, c.sort_at DESC NULLS LAST
  LIMIT 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.hle_on_disbursement_sent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_claim uuid;
  v_tenant uuid;
  v_check uuid;
BEGIN
  IF NEW.status NOT IN ('sent','completed','paid') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  SELECT ctx.resolved_claim_id, ctx.resolved_tenant_id, ctx.resolved_check_id
    INTO v_claim, v_tenant, v_check
  FROM public.resolve_homeowner_ledger_context(NEW.claim_id, NEW.check_id, NULL) ctx
  LIMIT 1;

  IF v_claim IS NULL OR v_tenant IS NULL THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.homeowner_ledger_events hle
    WHERE hle.payload_json->>'claim_disbursement_id' = NEW.id::text
      AND hle.event_type = 'funds_released'
  ) THEN
    INSERT INTO public.homeowner_ledger_events (
      tenant_id, claim_id, check_id, event_type, occurred_at, amount, actor_label, payload_json
    ) VALUES (
      v_tenant, v_claim, v_check, 'funds_released',
      now(), NEW.amount, NEW.recipient_name,
      jsonb_build_object(
        'claim_disbursement_id', NEW.id,
        'recipient_type', NEW.recipient_type,
        'recipient_name', NEW.recipient_name,
        'method', NEW.method,
        'status', NEW.status,
        'note', NEW.notes
      )
    );
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.mirror_loss_draft_upload_to_ledger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_claim uuid;
  v_tenant uuid;
  v_check uuid;
  v_actor text;
  v_event_type text;
  v_file_added boolean;
  v_newly_signed boolean;
BEGIN
  v_file_added := NEW.file_path IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.file_path IS DISTINCT FROM NEW.file_path);
  v_newly_signed := NEW.signature_status = 'signed' AND (TG_OP = 'INSERT' OR OLD.signature_status IS DISTINCT FROM NEW.signature_status);

  IF NOT v_file_added AND NOT v_newly_signed THEN
    RETURN NEW;
  END IF;

  SELECT ctx.resolved_claim_id, ctx.resolved_tenant_id, ctx.resolved_check_id
    INTO v_claim, v_tenant, v_check
  FROM public.resolve_homeowner_ledger_context(NULL, NULL, NEW.loss_draft_id) ctx
  LIMIT 1;

  IF v_claim IS NULL OR v_tenant IS NULL THEN
    RETURN NEW;
  END IF;

  v_event_type := CASE WHEN v_newly_signed THEN 'document_signed_all' ELSE 'document_uploaded' END;
  v_actor := CASE
    WHEN v_newly_signed THEN 'Signed document filed'
    WHEN NEW.is_template_generated THEN 'Document generated by ChecksOps'
    ELSE 'Document uploaded'
  END;

  IF NOT EXISTS (
    SELECT 1
    FROM public.homeowner_ledger_events hle
    WHERE hle.claim_id = v_claim
      AND hle.event_type = v_event_type
      AND hle.payload_json->>'loss_draft_document_id' = NEW.id::text
  ) THEN
    INSERT INTO public.homeowner_ledger_events (
      tenant_id, claim_id, check_id, event_type, occurred_at, actor_label, payload_json
    ) VALUES (
      v_tenant, v_claim, v_check, v_event_type,
      COALESCE(NEW.submitted_at, NEW.signed_at, NEW.updated_at, NEW.created_at, now()),
      v_actor,
      jsonb_build_object(
        'loss_draft_document_id', NEW.id,
        'document_label', NEW.document_label,
        'document_type',  NEW.document_type,
        'document_name',  COALESCE(NEW.file_name, NEW.document_label),
        'file_name',      NEW.file_name,
        'note',           NEW.notes
      )
    );
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.mirror_signature_request_to_homeowner_ledger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_claim uuid;
  v_tenant uuid;
  v_check_id uuid;
  v_occurred_at timestamptz;
BEGIN
  SELECT ctx.resolved_claim_id, ctx.resolved_tenant_id, ctx.resolved_check_id
    INTO v_claim, v_tenant, v_check_id
  FROM public.resolve_homeowner_ledger_context(NEW.claim_id, NEW.check_intake_item_id, NULL) ctx
  LIMIT 1;

  IF v_claim IS NULL OR v_tenant IS NULL THEN
    RETURN NEW;
  END IF;

  v_occurred_at := COALESCE(NEW.sent_at, NEW.last_attempted_at, NEW.created_at, now());

  IF v_occurred_at IS NOT NULL
     AND NEW.status IN ('pending', 'sent', 'partial', 'in_progress', 'completed')
     AND (TG_OP = 'INSERT' OR OLD.sent_at IS DISTINCT FROM NEW.sent_at OR OLD.status IS DISTINCT FROM NEW.status OR OLD.last_attempted_at IS DISTINCT FROM NEW.last_attempted_at)
     AND NOT EXISTS (
       SELECT 1 FROM public.homeowner_ledger_events hle
       WHERE hle.claim_id = v_claim
         AND hle.event_type = 'document_sent'
         AND hle.payload_json->>'signature_request_id' = NEW.id::text
     ) THEN
    INSERT INTO public.homeowner_ledger_events (
      tenant_id, claim_id, check_id, event_type, occurred_at, actor_label, payload_json
    ) VALUES (
      v_tenant, v_claim, v_check_id, 'document_sent', v_occurred_at, 'Document sent for signature',
      jsonb_build_object(
        'signature_request_id', NEW.id,
        'document_name', NEW.document_name,
        'document_label', NEW.document_name,
        'status', NEW.status,
        'delivery_mode', NEW.delivery_mode
      )
    );
  END IF;

  IF (NEW.completed_at IS NOT NULL OR NEW.status = 'completed')
     AND (TG_OP = 'INSERT' OR OLD.completed_at IS DISTINCT FROM NEW.completed_at OR OLD.status IS DISTINCT FROM NEW.status)
     AND NOT EXISTS (
       SELECT 1 FROM public.homeowner_ledger_events hle
       WHERE hle.claim_id = v_claim
         AND hle.event_type = 'document_signed_all'
         AND hle.payload_json->>'signature_request_id' = NEW.id::text
     ) THEN
    INSERT INTO public.homeowner_ledger_events (
      tenant_id, claim_id, check_id, event_type, occurred_at, actor_label, payload_json
    ) VALUES (
      v_tenant, v_claim, v_check_id, 'document_signed_all', COALESCE(NEW.completed_at, now()), 'Document fully signed',
      jsonb_build_object(
        'signature_request_id', NEW.id,
        'document_name', NEW.document_name,
        'document_label', NEW.document_name,
        'status', NEW.status
      )
    );
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.mirror_signature_signer_to_homeowner_ledger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_req record;
  v_claim uuid;
  v_tenant uuid;
  v_check_id uuid;
BEGIN
  IF NEW.status <> 'signed' OR (TG_OP = 'UPDATE' AND OLD.status IS NOT DISTINCT FROM NEW.status) THEN
    RETURN NEW;
  END IF;

  SELECT sr.id, sr.claim_id, sr.check_intake_item_id, sr.document_name
    INTO v_req
  FROM public.signature_requests sr
  WHERE sr.id = NEW.signature_request_id;

  SELECT ctx.resolved_claim_id, ctx.resolved_tenant_id, ctx.resolved_check_id
    INTO v_claim, v_tenant, v_check_id
  FROM public.resolve_homeowner_ledger_context(v_req.claim_id, v_req.check_intake_item_id, NULL) ctx
  LIMIT 1;

  IF v_claim IS NULL OR v_tenant IS NULL THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.homeowner_ledger_events hle
    WHERE hle.claim_id = v_claim
      AND hle.event_type = 'endorsement_signed'
      AND hle.payload_json->>'signer_id' = NEW.id::text
  ) THEN
    INSERT INTO public.homeowner_ledger_events (
      tenant_id, claim_id, check_id, event_type, occurred_at, actor_label, payload_json
    ) VALUES (
      v_tenant, v_claim, v_check_id, 'endorsement_signed', COALESCE(NEW.signed_at, now()), NEW.signer_name,
      jsonb_build_object(
        'signature_request_id', NEW.signature_request_id,
        'signer_id', NEW.id,
        'signer_name', NEW.signer_name,
        'signer_email', NEW.signer_email,
        'document_name', v_req.document_name,
        'document_label', v_req.document_name
      )
    );
  END IF;

  RETURN NEW;
END;
$$;