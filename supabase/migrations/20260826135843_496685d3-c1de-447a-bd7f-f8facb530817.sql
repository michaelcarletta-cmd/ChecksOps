DROP TRIGGER IF EXISTS complete_tasks_on_claim_settled_trigger ON public.claims;
DROP TRIGGER IF EXISTS trigger_automations_on_status_change ON public.claims;
DROP TRIGGER IF EXISTS trigger_create_tasks_from_automations ON public.claims;
DROP TRIGGER IF EXISTS trigger_delete_tasks_on_claim_closed ON public.claims;
DROP TRIGGER IF EXISTS trg_check_status_automations ON public.claim_checks;

DROP FUNCTION IF EXISTS public.complete_tasks_on_claim_settled() CASCADE;
DROP FUNCTION IF EXISTS public.trigger_status_change_automations() CASCADE;
DROP FUNCTION IF EXISTS public.create_tasks_from_automations() CASCADE;
DROP FUNCTION IF EXISTS public.delete_tasks_on_claim_closed() CASCADE;
DROP FUNCTION IF EXISTS public.fire_check_status_automations() CASCADE;
DROP FUNCTION IF EXISTS public.trigger_inspection_scheduled_automations() CASCADE;
DROP FUNCTION IF EXISTS public.trigger_task_completed_automations() CASCADE;

CREATE OR REPLACE FUNCTION public.trg_auto_create_loss_draft()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

    IF v_loss_draft_id IS NOT NULL THEN
      PERFORM public.init_loss_draft_documents(v_loss_draft_id);

      IF v_was_created THEN
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
$$;