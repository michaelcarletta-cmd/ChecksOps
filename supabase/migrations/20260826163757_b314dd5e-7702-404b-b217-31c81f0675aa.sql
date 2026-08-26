INSERT INTO public.user_roles (user_id, role)
SELECT 'dd24eea5-5d12-47d1-999e-d5930c278b7d'::uuid, r::public.app_role
FROM (VALUES ('admin'), ('staff')) AS v(r)
ON CONFLICT (user_id, role) DO NOTHING;