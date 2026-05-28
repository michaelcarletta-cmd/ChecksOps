-- Make claim_id optional on loss_draft_tracking
ALTER TABLE public.loss_draft_tracking ALTER COLUMN claim_id DROP NOT NULL;

-- Update trigger to create loss draft entry even when no claim is linked
CREATE OR REPLACE FUNCTION public.trg_auto_create_loss_draft()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_loss_draft_id uuid;
  v_mortgage_company text;
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
        claim_id,
        check_intake_item_id,
        mortgage_servicer,
        total_escrowed,
        holdback_amount,
        escrow_status,
        created_by
      ) VALUES (
        NEW.claim_id,
        NEW.id,
        COALESCE(v_mortgage_company, 'Unknown Lender'),
        COALESCE(NEW.amount, 0),
        COALESCE(NEW.amount, 0),
        'pending_send',
        NEW.reviewed_by
      ) ON CONFLICT (check_intake_item_id) WHERE check_intake_item_id IS NOT NULL DO NOTHING
      RETURNING id INTO v_loss_draft_id;

      IF v_loss_draft_id IS NOT NULL THEN
        PERFORM public.init_loss_draft_documents(v_loss_draft_id);

        -- Only create a task if a claim is linked (tasks require claim_id)
        IF NEW.claim_id IS NOT NULL THEN
          INSERT INTO public.tasks (claim_id, title, description, status, priority, due_date, created_by)
          VALUES (
            NEW.claim_id,
            'Loss Draft Endorsement - ' || COALESCE(v_mortgage_company, 'Unknown Lender'),
            'Check routed to Loss Draft. Ensure the check is sent for endorsement and tracking is updated.',
            'pending',
            'high',
            CURRENT_DATE + interval '1 day',
            NEW.reviewed_by
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