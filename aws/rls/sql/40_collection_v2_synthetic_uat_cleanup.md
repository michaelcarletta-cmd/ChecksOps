# SQL 40 — Collection V2 exact-ID synthetic UAT cleanup (prepare only)

STOP BEFORE STAGING SQL APPLY. This package is source/test only.

Application cleanup correctly failed: `checksops` / `authenticated` have no DELETE on `tenant_maintenance_payments`. This file does **not** grant that privilege.

Authorized leftover fixture (accepted synthetic UAT, still present after the 403 cleanup):

| Field | Value |
| --- | --- |
| Harness | `9ff1a038-2ea8-4d67-8082-74ffd2e79a7c` |
| TMP | `b0e70b5b-bbcb-4c74-a2a7-1b31aba8a9c1` |
| Provider transfer | `ebcacb2b-c2c4-4763-bb34-63f72973290f` |
| Tenant | `db13cc17-547b-4ca8-806a-f3cf79eafe59` |
| Marker | `SYNTHETIC_UAT_COLLECTION_V2` |
| Events | `60120c8f-5d83-4343-85f9-16bec592741e`, `1f832093-4d1b-43bd-829b-8fe34ccdbdb0` |
| Amount / env / status | 1 cent / sandbox / `returned` |

## 1. Exact proposed cleanup SQL

`aws/rls/sql/40_collection_v2_synthetic_uat_cleanup.sql`

One transaction: lock/statement timeouts, fail-closed guards, DELETE the two exact event rows, DELETE the exact TMP row, verify remaining counts, then COMMIT.

## 2. SHA-256

| Artifact | SHA-256 |
| --- | --- |
| SQL 40 source file | `9f691e72da8e3490489854f685f470884441e61e2475b91e92fec55fd80b5de8` |
| Canonical present fixture (expected live) | `48c32f695046582285a5dd97433a52da528ad8be0f6b33c2d46c3395a51e98f0` |
| Canonical empty fixture (intended after) | `40a486ede83069b6b640ef4c4b06b88585be2b30102673bccde22238b185405d` |

`expected_live_definition_sha256` at apply time is the immediately-before live fixture hash from executor `inspect`. It must equal the present hash above if the leftover fixture is unchanged. `intended_replacement_sha256` is the empty hash.

## 3. Fail-closed assertions

Refuse (RAISE + implicit ROLLBACK) unless:

- authorized IDs are not the Freedom IDs
- the selected TMP exists and matches exact id + isolation tenant + synthetic transfer + 1 cent + sandbox + `returned` + marker + `harness=<id>`
- exactly 1 matching TMP
- the two selected event IDs exist and both match provider-transfer + tenant + marker + harness + `checksops_payment_id`
- exactly 2 matching events
- 0 `payment_transfers` matching the synthetic transfer / TMP / harness
- selected TMP / event rows do not reference Freedom tenant `2eff5f1a-929d-4ce3-9a8b-cd96b98df42a`, Freedom TMP `72b622f9-b68f-4032-a971-a854dbcfbf57`, or Freedom transfer `b31c7752-031f-4b8b-9b6e-82dd0aaed2cb`
- GET DIAGNOSTICS after event DELETE = 2
- GET DIAGNOSTICS after TMP DELETE = 1
- remaining authorized TMP / event / synthetic-transfer counts are 0 before COMMIT

Freedom `$139` rows may exist and must be left untouched. Matching counts do **not** include Freedom transfer/TMP IDs.

## 4. Expected affected rows

| Table | DELETE count | Predicate |
| --- | --- | --- |
| `payment_event_log` | 2 | exact event IDs plus transfer/tenant/marker/harness/TMP metadata |
| `tenant_maintenance_payments` | 1 | exact TMP ID plus tenant/transfer/1¢/sandbox/`returned`/marker/harness |
| `payment_transfers` | 0 | none deleted |

No marker-only, tenant-only, or provider-transfer-only DELETE.

## 5. Executor privilege explanation

- Live application grants on `tenant_maintenance_payments`: SELECT / INSERT / UPDATE to `authenticated` and `checksops`. No DELETE.
- `payment_event_log`: authenticated SELECT only.
- Application `cleanup` 403 is `42501` permission denied, not an RLS policy miss.
- Do not GRANT DELETE to `checksops`, `authenticated`, or other application roles.
- The guarded executor connects as `checksops_admin` via `ADMIN_SECRET_ARN`.
- Table owner is `checksops_admin`. `FORCE ROW LEVEL SECURITY` is false, so the owner bypasses RLS and can DELETE these exact rows.
- SQL 40 contains no GRANT / REVOKE / RLS / SQL 39 policy change.

## 6. Tests

- `aws/tests/collection-v2-synthetic-uat-cleanup.test.mjs` — source contract, hashes, fail-closed names, no grants/RLS
- `aws/tests/collection-v2-synthetic-uat-cleanup-pg.test.mjs` — isolated PostgreSQL 16: happy path, Freedom coexistence, decoy marker row survives, application DELETE denied, mismatch rollback

## 7. Guarded staging apply plan (not executed here)

1. Do not apply from this workstream unless a later reviewed authorization exists.
2. `sql-executor-ensure` only (NON_SHARED). Never `checksops-staging-api`. Embed SQL 40.
3. Executor `inspect` / `authorize` against `staging-sql` / `sql-executor-invoke`. Require live fixture hash = present hash above or `SQL_COLLISION`.
4. Official evaluate-only preflight (no lease in this prepare):
   - `node scripts/deployment-guard/preflight.mjs --input <sql40-identity.json>`
   - `deployment_type=sql-executor-invoke`
   - `target_environment=staging`
   - `target_component=staging-sql`
   - `filename` / `migration_id` / `source_sha256` / `commit` bound to this file
   - `expected_live_definition_sha256` = present fixture hash
   - `intended_replacement_sha256` = empty fixture hash
5. Later apply, if authorized: signed receipt + `sql-executor-invoke` `action=apply`. Immediately-before live hash must still match. One-use id. Never `psql` / direct RDS / env-var bypass.
6. After apply: remaining authorized TMP = 0, events = 0, Freedom `$139` still present.
7. Do not change SQL 39. Do not modify application Lambda. Do not touch production.

Production is out of scope. STOP BEFORE EXECUTION.
