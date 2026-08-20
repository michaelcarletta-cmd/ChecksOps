CREATE OR REPLACE FUNCTION public.log_usage_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_tenant_id uuid;
    v_event_type text;
    v_description text;
    v_amount_cents integer := 0;
BEGIN
    IF TG_TABLE_NAME = 'claim_checks' THEN
        IF TG_OP = 'INSERT' THEN
            IF NEW.deposit_status IS DISTINCT FROM 'deposited' THEN
                RETURN NEW;
            END IF;
        ELSIF TG_OP = 'UPDATE' THEN
            IF NOT (OLD.deposit_status IS DISTINCT FROM NEW.deposit_status AND NEW.deposit_status = 'deposited') THEN
                RETURN NEW;
            END IF;
        ELSE
            RETURN NEW;
        END IF;

        v_tenant_id := NEW.tenant_id;
        v_event_type := 'check_processing';
        v_description := 'Check #' || COALESCE(NEW.check_number, 'Unknown') || ' deposited';
        SELECT COALESCE(per_check_rate_cents, 0)
          INTO v_amount_cents
          FROM public.tenants
         WHERE id = NEW.tenant_id;

    ELSIF TG_TABLE_NAME = 'moov_invoices' AND TG_OP = 'UPDATE' THEN
        IF NOT (OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'paid') THEN
            RETURN NEW;
        END IF;

        v_tenant_id := NEW.tenant_id;
        v_event_type := 'invoice_payment';
        v_description := 'Invoice #' || COALESCE(NEW.invoice_number, NEW.id::text) || ' paid';
        v_amount_cents := NEW.total_amount;

    ELSIF TG_TABLE_NAME = 'check_intake_items' AND TG_OP = 'INSERT' THEN
        v_tenant_id := NEW.tenant_id;
        v_event_type := 'ocr_intake';
        v_description := 'New check intake uploaded';
    ELSE
        RETURN NEW;
    END IF;

    IF v_tenant_id IS NOT NULL THEN
        INSERT INTO public.tenant_usage_logs (tenant_id, event_type, description, amount_cents)
        VALUES (v_tenant_id, v_event_type, v_description, v_amount_cents);
    END IF;

    RETURN NEW;
END;
$$;