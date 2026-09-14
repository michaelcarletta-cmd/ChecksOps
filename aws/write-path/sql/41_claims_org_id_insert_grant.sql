-- Integration RC 2026-09-14: treat as already applied on staging unless a
-- later read-only catalog proves otherwise. Do NOT backfill claims.org_id.
-- Do NOT run 23_claims_org_backfill.sql. Git lineage only in this RC.
--
-- Phase 2: tracking-claim INSERT so ClaimLedgerCard can create a tenant-scoped
-- claims row. org_id is required by RLS WITH CHECK (aws_can_write_tenant).
-- Application executeClaims assigns org_id from caller membership and ignores
-- spoofed orgs the caller cannot write.
-- Does not add UPDATE or DELETE privileges on claims.
-- Does not GRANT check_intake_items.claim_id.

GRANT SELECT ON TABLE public.claims TO checksops, authenticated;

GRANT INSERT (
  claim_number,
  status,
  org_id
) ON TABLE public.claims TO checksops, authenticated;
