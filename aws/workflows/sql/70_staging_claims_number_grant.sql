-- AWS staging: column-scoped GRANT so authorized tenants can rename an existing claim.
-- Does not INSERT or DELETE claims. Does not GRANT amount/org_id/status/financial columns.
-- Does not ENABLE/FORCE RLS. Does not create or replace policies.
-- Does not touch production.

GRANT UPDATE (claim_number, updated_at) ON TABLE public.claims TO checksops;
