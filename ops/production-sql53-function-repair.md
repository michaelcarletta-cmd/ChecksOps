# SQL53 missing settlement function repair

## SQL53_FUNCTION_REPAIR_READY: YES

Source-only. Do not merge or deploy until independently authorized.

## Root cause

Production has the 17 `claim_settlements` amount columns and the three `check_intake_items` ledger triggers, but it does not have `public.save_claim_settlement_breakdown(uuid,uuid,jsonb)`. The AWS Claim Settlement editor routes `claim_settlements` insert/update through that RPC. A missing function makes that save path fail. Columns and ledger triggers are not the gap.

## Original definition

Located: YES — `aws/workflows/sql/53_claim_settlement_breakdown.sql`

- `SECURITY DEFINER`, `search_path = pg_catalog, public`, `row_security = off`
- Tenant gate: `auth.uid()` plus `public.aws_can_write_claim(p_claim_id)`
- Writes only the 17 settlement amount columns on `public.claim_settlements`
- `REVOKE ALL` from `PUBLIC`, `authenticated`, `anon`
- `GRANT EXECUTE` to `checksops` only
- Source SHA-256 `5a8f8bc35c69f2b339c78f3637d6bb1c606117967e3ab9d83b5dec1d37561197`
- Intended live definition SHA-256 `6542c3f6fb3f7d50b758b3d7352fe6fb49cbe8cd2bd5c6061dbc35a6e9fccf52`

The file does not create tables, columns, triggers, or other functions.

## Application features affected

- Claim Settlement editor on Claim Ledger and Loss Draft detail
- AWS client remaps `claim_settlements` insert/update to `POST /data/rpc` `save_claim_settlement_breakdown`
- Lambda `data.mjs` early-routes that name to `handleClaimSettlementRpc`
- Requires `AWS_APPLICATION_WORKFLOW_WRITES_ENABLED=true` at the API
- Does not write checks, payments, disbursements, Moov, endorsement, or signature state
- Does not fire `check_intake_items` ledger triggers

## Isolated staging test

Local PostgreSQL 16, synthetic two-tenant data, official SQL 53 file only.

- Insert and in-place update succeed for the owner tenant
- Duplicate save does not insert a second settlement row
- Cross-tenant and role-less callers receive `not_authorized`
- `checksops` cannot update `claims.org_id`
- `authenticated` and `anon` cannot execute the function
- Ledger triggers, `check_intake_items`, `payments`, and `homeowner_ledger` stay untouched

## Production preflight (later authorization)

1. Fresh official SQL53 read-only inspect: function `exists=false`, 17 columns present, 3 ledger triggers present, `aws_can_write_claim` present.
2. Confirm source bytes still match the pin.
3. Official `sql-apply` receipt for this file only. Existing staging evaluator must continue to refuse production until a separate production apply authorization exists.
4. Do not apply 44, 20261007193200, or the one-writer migration.

## Post-deployment verification

- Inspect `save_claim_settlement_breakdown` `exists=true` and definition SHA-256 `6542c3f6fb3f7d50b758b3d7352fe6fb49cbe8cd2bd5c6061dbc35a6e9fccf52`
- Columns, ledger triggers, and the other three SQL53 functions unchanged
- No check/payment/disbursement row changes from the apply itself

## Rollback

If and only if this function was just created and inspect previously showed `exists=false`:

```sql
DROP FUNCTION IF EXISTS public.save_claim_settlement_breakdown(uuid, uuid, jsonb);
```

Do not drop tables, columns, triggers, or `aws_can_write_claim` / ledger functions.

## Out of scope

No production SQL apply in this PR. No Lambda, IAM, auth, or payment changes. No temporary Cursor OIDC recreation.
