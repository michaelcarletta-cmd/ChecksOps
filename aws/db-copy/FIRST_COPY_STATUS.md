# First copy attempt — restore complete; temp Lambda deleted

Isolated database `checksops` was restored from the approved S3 custom dump using a dedicated one-shot Lambda/role. The staging API still uses `dbname=postgres`. Production Lovable/Supabase, Auth, Storage, RLS activation, realtime, Moov, CheckAlt, payment webhooks, DNS, frontend, and `main` were not changed.

## Backup

- Bucket: `checksops-staging-privatefilesbucket-erzqsolpucjp`
- Requested key: `migration/checksops_260901.backup` (not found)
- Actual key: `Migration/checksops_260901(1).backup`
- Size: 49,100,401 bytes (49.1 MB)
- Format: PostgreSQL custom (`PGDMP`)
- Not committed to Git

## Restore target

- RDS: `checksops-staging.cyr0q4kcop3c.us-east-1.rds.amazonaws.com:5432` (private, PostgreSQL 18.3)
- New database: `checksops` (created; partial retries dropped only this database)
- Maintenance database `postgres`: not dropped, not restored into
- Temporary Lambda: `checksops-staging-restore-oneshot` (same VPC/subnets/SG as the API)
- Temporary role: `checksops-staging-restore-oneshot` (admin secret + that one S3 object + VPC ENI actions)
- API role `checksops-staging-ApiFunctionRole-7E7XRyLe3nyi` was **not** granted the RDS admin secret

## Catalog (database `checksops`)

| Object | Restored | Live inventory |
| --- | --- | --- |
| Public base tables | 166 | 166 |
| Public views | 22 | 20 |
| Public functions (`prokind` f/p) | 965 | 960 |
| Public non-internal triggers (`pg_trigger`) | 164 | 211 `information_schema` event rows (same 164 triggers) |
| RLS policies restored | 0 | 380 (intentionally not applied) |
| RLS-enabled tables | 0 | n/a |

Two extra views vs the live inventory are consistent with PostGIS catalog views (`geography_columns`, `geometry_columns`). The trigger 211 vs 164 gap is `information_schema` event expansion (47 extra rows from 37 multi-event triggers), not dropped public triggers. Sentinel table `public._checksops_restore_complete` was written.

Post-restore FK/trigger/financial validation (no cutover): `aws/db-copy/POST_RESTORE_CLEANUP.md`.

Extensions enabled: `plpgsql`, `pgcrypto` 1.4 (schema `extensions`), `uuid-ossp` 1.1 (schema `extensions`), `pg_stat_statements` 1.12, `postgis` 3.6.3, `vector` 0.8.1 (schema `extensions`).

## 166-table reconciliation

`sql/reconciliation_counts.sql` ran against restored `checksops`: **166/166 tables present and countable**. No missing tables. 100 tables have rows; 66 are empty. Live row-by-row comparison was not possible in this pass (no live source URI); the approved S3 dump is the source.

Selected restored row counts:

- `check_intake_items`: 182
- `check_endorsements`: 502
- `deposit_items`: 114
- `deposit_batches`: 115
- `checkalt_deposits`: 58
- `disbursement_splits`: 108
- `disbursement_batches`: 109
- `claim_payments`: 13
- `homeowner_ledger_events`: 657
- `tenants`: 6
- `payment_transfers`: 0
- `payment_wallet_ledger`: 0
- `claim_check_payments`: 0

## Financial reconciliation (restored `checksops`)

From `sql/reconciliation_financial.sql`:

| Metric | Value |
| --- | --- |
| check_intake_amount | 1317000.53 |
| check_intake_pa_fee_amount | 5393.27 |
| deposit_items_amount | 963972.98 |
| deposit_batches_total_amount | 964752.98 |
| checkalt_deposits_amount | 380333.17 |
| disbursement_splits_amount | 822212.97 |
| disbursement_batches_check_amount | 829768.914 |
| disbursement_batches_amount_reserved_cents | 0 |
| claim_check_payments_check_amount | 0 |
| claim_check_payments_payment_amount | 0 |
| endorsed_check_intake_amount | 3924356.85 |
| payment_transfers_amount_cents | 0 |
| payment_wallet_ledger_amount_cents | 0 |
| claim_payments_amount | 66003.92 |
| homeowner_ledger_amount | 2977337.23 |

## Exclusions (by design)

- Auth: empty `auth.users` stub only; 9 Auth users / hashes / sessions / MFA not loaded
- Storage objects not copied
- RLS policies not restored; RLS not enabled
- realtime / cron / net / vault / pgmq / pgsodium extensions not enabled
- TOC filter skipped ~2542 dump entries (excluded schemas, ACLs, policies, extensions, TABLE ATTACH, supabase admins)
- **47 public FK constraints referencing `auth.users` were not applied** (live inventory said 0 such FKs; the dump has them). Public-to-public FKs were restored. Application data was kept; Auth rows were not loaded to satisfy those FKs
- Public functions still referencing stubs: `auth.uid` 40, `net` 4, `pgmq` 4, `vault` 3 (cron 0 found). No net/cron/vault/pgmq triggers required disabling
- Grants: `CONNECT` + `SELECT` to role `checksops` on database `checksops` only

## Staging API (unchanged)

- `DATABASE_SECRET_ARN` remains the application secret `.../checksops/1788286468693-b4U0Rn` (not `checksops_admin`)
- `/db-health` 200 after restore and after deleting the one-shot Lambda (`postgresqlVersion` 18.3, `select1` ok)
- API function role was previously `AccessDeniedException` on `secretsmanager:GetSecretValue` for the admin secret; that grant was never added
- Operator cannot `iam:SimulatePrincipalPolicy` on the API role (not requested; not granted)

## Cleanup

- Deleted Lambda `checksops-staging-restore-oneshot` (`ResourceNotFoundException`)
- Deleted IAM role `checksops-staging-restore-oneshot`: removed inline policy `oneshot-restore-least-privilege`, no managed policies attached, `iam:GetRole` is `NoSuchEntity`
- Staging API `DATABASE_SECRET_ARN` remains the application secret (not `checksops_admin`). Inline `ApiFunctionRolePolicy4` grants `GetSecretValue` only on that app secret; none of the API role policies mention the admin secret
- `/db-health` 200 (PostgreSQL 18.3, `select1` ok)

Cognito identity mapping (planning only, no user import): `aws/db-copy/analysis/COGNITO_IDENTITY_MAPPING.md`.

## Ready for next phase?

- **Isolated AWS staging database `checksops`:** yes
- **API cutover / Auth import / Storage / RLS / webhooks / DNS / frontend / `main`:** no
