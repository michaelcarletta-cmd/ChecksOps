-- Backfill missing document checklists for any loss drafts that have none
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT ld.id
    FROM public.loss_draft_tracking ld
    WHERE NOT EXISTS (
      SELECT 1 FROM public.loss_draft_documents ldd WHERE ldd.loss_draft_id = ld.id
    )
  LOOP
    PERFORM public.init_loss_draft_documents(r.id);
  END LOOP;
END$$;

-- Harden trigger: always ensure docs are initialized after a loss draft exists for the check
CREATE OR REPLACE FUNCTION public.trg_auto_create_loss_draft()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_loss_draft_id uuid;
  v_mortgage_company text;
  v_was_created boolean := false;
BEGIN
  IF NEW.status = 'loss_draft_required' AND (OLD.status IS DISTINCT FROM 'loss_draft_required') THEN

    SELECT id INTO v_loss_draft_id
    FROM public.loss_draft_tracking
    WHERE check_intake_item_id = NEW.id
    LIMIT 1;

    IF v_loss_draft_id IS NULL THEN
      SELECT payee_name INTO v_mortgage_company
      FROM public.check_payees
      WHERE check_id = NEW.id AND payee_type = 'mortgage_company'
      LIMIT 1;

      INSERT INTO public.loss_draft_tracking (
        claim_id, check_intake_item_id, mortgage_servicer,
        total_escrowed, holdback_amount, escrow_status, created_by
      ) VALUES (
        NEW.claim_id, NEW.id,
        COALESCE(v_mortgage_company, 'Unknown Lender'),
        COALESCE(NEW.amount, 0), COALESCE(NEW.amount, 0),
        'pending_send', NEW.reviewed_by
      )
      RETURNING id INTO v_loss_draft_id;

      v_was_created := true;
    END IF;

    -- Always ensure docs are initialized (idempotent via ON CONFLICT DO NOTHING)
    IF v_loss_draft_id IS NOT NULL THEN
      PERFORM public.init_loss_draft_documents(v_loss_draft_id);

      IF v_was_created THEN
        IF NEW.claim_id IS NOT NULL THEN
          INSERT INTO public.tasks (claim_id, title, description, status, priority, due_date, created_by)
          VALUES (
            NEW.claim_id,
            'Loss Draft Endorsement - ' || COALESCE(v_mortgage_company, 'Unknown Lender'),
            'Check routed to Loss Draft. Ensure the check is sent for endorsement and tracking is updated.',
            'pending', 'high', CURRENT_DATE + interval '1 day', NEW.reviewed_by
          );
        END IF;

        INSERT INTO public.check_audit_log (check_id, event_type, event_description, actor_id)
        VALUES (NEW.id, 'loss_draft_auto_created',
          CASE WHEN NEW.claim_id IS NULL
            THEN 'Auto-created loss draft tracking record (no claim linked)'
            ELSE 'Auto-created loss draft tracking record' END,
          NEW.reviewed_by);
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;