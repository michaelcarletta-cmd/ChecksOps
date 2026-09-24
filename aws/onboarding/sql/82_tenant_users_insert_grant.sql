-- Staging operator SQL: allow invite-created tenant_users rows.
-- Platform-owner / tenant-admin INSERT is still constrained by aws_write_tenant_users.
-- Does not rewrite existing memberships. Operator review required.

GRANT INSERT ON TABLE public.tenant_users TO checksops;
