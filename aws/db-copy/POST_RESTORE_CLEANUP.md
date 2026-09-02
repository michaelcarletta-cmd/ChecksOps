# Post-restore cleanup and compatibility validation

No API/Auth/Storage/RLS/webhook/DNS/frontend/`main` cutover.

## 1. Temporary restore IAM role

Lambda `checksops-staging-restore-oneshot` does not exist (`ResourceNotFoundException`).

Role `checksops-staging-restore-oneshot` was deleted: listed inline policy `oneshot-restore-least-privilege`, deleted that policy, listed attached managed policies (none), deleted the role (`iam:GetRole` → `NoSuchEntity`).

Staging API still uses the application DB secret (not `checksops_admin`). `/db-health` remains 200. No other AWS or database changes.

## 2. Skipped `auth.users` FKs

47 public constraints inventoried from the backup. Not restored. Table and Cognito categories: `analysis/skipped_auth_users_fks.md`.

## 3. Trigger 211 vs 164

Not 47 missing public triggers. Live 211 is `information_schema.triggers` event rows; dump and RDS have 164 `pg_trigger` objects. `analysis/TRIGGER_RECONCILIATION.md`. No application/data-integrity trigger missing versus the backup.

## 4. Financial and 166-table validation versus backup

Restored RDS was not modified. Dump `TABLE DATA` recomputed the same 15 financial metrics (all match). 165/166 application table row counts match; `spatial_ref_sys` is 0 in dump data and 8500 on RDS from `CREATE EXTENSION postgis`.

JSON: `analysis/financial_backup_vs_restore.json`, `analysis/table_counts_backup_vs_restore.json`.

Cognito identity mapping (planning only; no user import, API still on `postgres`): `analysis/COGNITO_IDENTITY_MAPPING.md`.
