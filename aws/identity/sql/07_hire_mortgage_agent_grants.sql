-- Staging-only GRANTs for hire-mortgage-agent / tenant invite identity writes.
-- Does NOT apply 64_financial_activation_grants.sql.
-- Does NOT grant financial table DML.
-- Applied as checksops_admin via temporary in-VPC oneshot, then oneshot deleted.

GRANT SELECT, INSERT, UPDATE ON TABLE public.profiles TO checksops;
GRANT SELECT, INSERT, UPDATE ON TABLE public.identity_accounts TO checksops;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_roles TO checksops;
