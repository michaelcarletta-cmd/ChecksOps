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

-- 3. Seed some initial data if possible or create a trigger to backfill from existing usage events if they exist
-- For now, we'll assume new events will be logged.

-- Function to check if a tenant has reached their cap
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
