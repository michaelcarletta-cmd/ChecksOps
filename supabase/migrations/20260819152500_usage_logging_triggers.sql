-- Function to log usage from various tables
CREATE OR REPLACE FUNCTION public.log_usage_event()
RETURNS TRIGGER AS $$
DECLARE
    v_tenant_id uuid;
    v_event_type text;
    v_description text;
    v_amount_cents integer := 0;
BEGIN
    IF TG_TABLE_NAME = 'claim_checks' AND (TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND OLD.status != NEW.status AND NEW.status = 'deposited')) THEN
        -- Log check processing when deposited
        SELECT tenant_id INTO v_tenant_id FROM public.tenants WHERE id = NEW.tenant_id;
        v_event_type := 'check_processing';
        v_description := 'Check #' || COALESCE(NEW.check_number, 'Unknown') || ' deposited';
        -- Approximate amount based on tenant rate if available, else 0
        SELECT COALESCE(per_check_rate_cents, 0) INTO v_amount_cents FROM public.tenants WHERE id = NEW.tenant_id;
    
    ELSIF TG_TABLE_NAME = 'moov_invoices' AND TG_OP = 'UPDATE' AND OLD.status != NEW.status AND NEW.status = 'paid' THEN
        -- Log invoice payment
        v_tenant_id := NEW.tenant_id;
        v_event_type := 'invoice_payment';
        v_description := 'Invoice #' || COALESCE(NEW.invoice_number, NEW.id::text) || ' paid';
        v_amount_cents := NEW.total_amount;

    ELSIF TG_TABLE_NAME = 'check_intake_items' AND TG_OP = 'INSERT' THEN
        -- Log OCR intake
        v_tenant_id := NEW.tenant_id;
        v_event_type := 'ocr_intake';
        v_description := 'New check intake uploaded';
    END IF;

    IF v_tenant_id IS NOT NULL THEN
        INSERT INTO public.tenant_usage_logs (tenant_id, event_type, description, amount_cents)
        VALUES (v_tenant_id, v_event_type, v_description, v_amount_cents);
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Apply triggers
DROP TRIGGER IF EXISTS trg_log_check_usage ON public.claim_checks;
CREATE TRIGGER trg_log_check_usage
AFTER INSERT OR UPDATE ON public.claim_checks
FOR EACH ROW EXECUTE FUNCTION public.log_usage_event();

DROP TRIGGER IF EXISTS trg_log_invoice_usage ON public.moov_invoices;
CREATE TRIGGER trg_log_invoice_usage
AFTER UPDATE ON public.moov_invoices
FOR EACH ROW EXECUTE FUNCTION public.log_usage_event();

DROP TRIGGER IF EXISTS trg_log_intake_usage ON public.check_intake_items;
CREATE TRIGGER trg_log_intake_usage
AFTER INSERT ON public.check_intake_items
FOR EACH ROW EXECUTE FUNCTION public.log_usage_event();
