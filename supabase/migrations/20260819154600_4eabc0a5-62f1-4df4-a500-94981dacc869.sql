INSERT INTO public.tenant_usage_logs (tenant_id, event_type, description, amount_cents)
SELECT id, 'system_init', 'System initialized usage tracking', 0 
FROM public.tenants 
LIMIT 5;