# Global staging RLS activation

This phase **ENABLE ROW LEVEL SECURITY** on the 165 restored tables from the approved backup, then validates fail-closed authorization against the live globally enabled database.

It does **not**:

- invite the 8 production users
- create Cognito, email, tenant membership, or extra privileges for ninth UUID `dd24eea5-5d12-47d1-999e-d5930c278b7d`
- use `FORCE ROW LEVEL SECURITY`
- add permissive fallback policies
- grant lasting INSERT/UPDATE/DELETE to `checksops` on restored tables
- generally lift the API `default_transaction_read_only=on` brake
- call Moov, CheckAlt, Plaid, or Resend
- change production Lovable/Supabase, `main`, DNS, frontend, Storage, or payment endpoints

Identity remains:

`Cognito sub -> identity_accounts.application_user_id -> existing ChecksOps UUID -> request.app_user_id -> auth.uid()`

## Inventory (abort if live snapshot differs)

| Check | Expected |
| --- | ---: |
| Restored application COPY tables | 166 |
| Dump/public RLS tables | 165 |
| `aws_select_*` | 165 |
| `aws_write_*` | 127 |
| Dump leftover policies | 0 |
| Identity FKs | 47 |
| Claims / Freedom / NULL-org | 180 / 83 / 97 |
| Server-side API (no write policy) | 13 |
| Obsolete (no write policy) | 2 |
| Platform-owner write tables | 7 |
| Not enabled | `spatial_ref_sys` (and `identity_accounts`) |

SQL: `aws/rls/sql/26_enable_rls.sql`. Rollback-only disable: `aws/rls/sql/27_disable_rls.sql`.

## Validation

Oneshot `step=enableRls` (temporary in-VPC Lambda as `checksops_admin`):

1. Pre-enable snapshot; abort on mismatch.
2. ENABLE the 165 tables in one transaction and COMMIT. No FORCE.
3. Live SELECT authorization (RLS already on; not simulated inside the same transaction).
4. Write tests inside a rolled-back transaction: temporary DML GRANT to `checksops`, `SET LOCAL default_transaction_read_only=off`, synthetic/no-op DML, ROLLBACK (grants and rows gone).
5. Regression: `/db-health` path remains `checksops` + read-only; core counts and financial aggregates as owner; FK/policy/RLS counts.

If a rollback condition hits (unexpected cross-tenant access, NULL-org leak to ordinary users, server-side tables writable through the application role, or unexplained same-tenant failure), DISABLE only the 165 tables from this phase, keep policies, and report the failing test.

## API

`GET /db-readonly-validate` is dual-mode: RLS off still reconciles restore counts; RLS on expects fail-closed zero rows for `checksops` without `request.app_user_id`. Restore financial totals are reconciled by the oneshot as table owner.

`/authorization/isolation` reports claims/check visibility under the mapped application UUID. Spoofed headers/query/body remain ignored. Unauthenticated calls stay 401.
