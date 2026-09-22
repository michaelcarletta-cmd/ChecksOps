-- Smallest AWS claim-create grant.
-- Application write path is insert-only (claim_number, status).
-- Client org_id/tenant_id stay ignored; trg_aws_stamp_claim_org_id remains
-- authoritative. RLS aws_write_claims WITH CHECK (aws_can_write_tenant(org_id))
-- stays in force. Do not GRANT UPDATE or DELETE.

GRANT INSERT ON TABLE public.claims TO checksops;
