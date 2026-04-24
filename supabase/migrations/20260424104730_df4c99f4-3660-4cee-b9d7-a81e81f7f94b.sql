-- Backfill Freedom Claims (system tenant) membership for all app-level admins
-- so RLS on tenant_partnerships allows them to see active partnerships
-- (e.g., Condition One Commercial) inside the Share Check dialog.
INSERT INTO public.tenant_users (tenant_id, user_id, role)
SELECT t.id, ur.user_id, 'admin'::public.tenant_role
FROM public.tenants t
CROSS JOIN public.user_roles ur
WHERE t.is_system_tenant = true
  AND ur.role = 'admin'
ON CONFLICT DO NOTHING;