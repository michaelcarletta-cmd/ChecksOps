-- Remove the duplicate payments@condition1commercial.com account that was created by mistake
-- in the white-label tenant settings. This account is causing role confusion.
DELETE FROM public.user_roles WHERE user_id = '410f1ba7-3764-4e90-9980-93e0450d7272';
DELETE FROM public.tenant_users WHERE user_id = '410f1ba7-3764-4e90-9980-93e0450d7272';
DELETE FROM public.profiles WHERE id = '410f1ba7-3764-4e90-9980-93e0450d7272';