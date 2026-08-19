-- 1. Create tenant_usage_logs table for filtering and visibility
CREATE TABLE public.tenant_usage_logs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    event_type text NOT NULL, -- 'check_processing', 'mortgage_handling', 'disbursement', etc.
    description text,
    amount_cents integer DEFAULT 0,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamptz DEFAULT now()
);

GRANT SELECT, INSERT ON public.tenant_usage_logs TO authenticated;
GRANT ALL ON public.tenant_usage_logs TO service_role;

ALTER TABLE public.tenant_usage_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own tenant usage logs"
    ON public.tenant_usage_logs
    FOR SELECT
    TO authenticated
    USING (tenant_id IN (SELECT tenant_id FROM public.tenant_users WHERE user_id = auth.uid()));

-- 2. Add team member caps to tenants table
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS vendor_cap integer DEFAULT 5;
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS sales_rep_cap integer DEFAULT 5;
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS subcontractor_cap integer DEFAULT 5;

-- 3. Function to check if a tenant has reached their cap
CREATE OR REPLACE FUNCTION public.check_team_member_cap(_tenant_id uuid, _role text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    current_count integer;
    max_cap integer;
BEGIN
    -- Count current members with this role
    SELECT count(*) INTO current_count
    FROM public.tenant_users
    WHERE tenant_id = _tenant_id AND role = _role;

    -- Get cap for this role
    IF _role = 'vendor' THEN
        SELECT vendor_cap INTO max_cap FROM public.tenants WHERE id = _tenant_id;
    ELSIF _role = 'sales_rep' THEN
        SELECT sales_rep_cap INTO max_cap FROM public.tenants WHERE id = _tenant_id;
    ELSIF _role = 'subcontractor' THEN
        SELECT subcontractor_cap INTO max_cap FROM public.tenants WHERE id = _tenant_id;
    ELSE
        RETURN true; -- No cap for other roles
    END IF;

    RETURN current_count < COALESCE(max_cap, 5);
END;
$$;

-- 4. Function to log usage from various tables
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
        v_tenant_id := NEW.tenant_id;
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

-- 5. Apply triggers
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
