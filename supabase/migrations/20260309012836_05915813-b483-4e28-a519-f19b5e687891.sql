CREATE UNIQUE INDEX IF NOT EXISTS idx_loss_draft_check_id ON public.loss_draft_tracking USING btree (check_intake_item_id) WHERE (check_intake_item_id IS NOT NULL);

CREATE OR REPLACE FUNCTION public.trg_auto_create_loss_draft()
RETURNS TRIGGER AS $$
DECLARE
  v_loss_draft_id uuid;
  v_mortgage_company text;
BEGIN
  -- Only fire when status changes to 'loss_draft_required'
  IF NEW.status = 'loss_draft_required' AND (OLD.status IS DISTINCT FROM 'loss_draft_required') THEN
    
    -- Ensure claim_id exists
    IF NEW.claim_id IS NULL THEN
      RETURN NEW;
    END IF;

    -- Check if it already exists
    SELECT id INTO v_loss_draft_id 
    FROM public.loss_draft_tracking 
    WHERE check_intake_item_id = NEW.id 
    LIMIT 1;

    IF v_loss_draft_id IS NULL THEN
      -- Try to get the mortgage company from payees
      SELECT payee_name INTO v_mortgage_company 
      FROM public.check_payees 
      WHERE check_id = NEW.id AND payee_type = 'mortgage_company' 
      LIMIT 1;

      -- Insert idempotently
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

      -- If we successfully inserted
      IF v_loss_draft_id IS NOT NULL THEN
        -- Initialize documents
        PERFORM public.init_loss_draft_documents(v_loss_draft_id);

        -- Create task
        INSERT INTO public.tasks (claim_id, title, description, status, priority, due_date, created_by, category)
        VALUES (
          NEW.claim_id, 
          'Loss Draft Endorsement - ' || COALESCE(v_mortgage_company, 'Unknown Lender'), 
          'Check routed to Loss Draft. Ensure the check is sent for endorsement and tracking is updated.', 
          'todo', 
          'high', 
          CURRENT_DATE + interval '1 day', 
          NEW.reviewed_by, 
          'loss_draft'
        );

        -- Add audit
        INSERT INTO public.check_audit_log (check_id, event_type, event_description, actor_id)
        VALUES (NEW.id, 'loss_draft_auto_created', 'Auto-created loss draft tracking record', NEW.reviewed_by);
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_auto_create_loss_draft ON public.check_intake_items;

CREATE TRIGGER trg_auto_create_loss_draft
AFTER UPDATE ON public.check_intake_items
FOR EACH ROW
EXECUTE FUNCTION public.trg_auto_create_loss_draft();