# Migration rehearsal & final cutover delta procedure

**PR:** #127  
**Branch:** `cursor/migration-rehearsal-cutover-c8f0`  
**Nature:** Non-destructive production → AWS staging rehearsal. **Not** production cutover.

## Safety (hard)

| Rule | Status |
|---|---|
| Production Supabase/Lovable READ-ONLY | Required |
| No production Auth / DNS / webhook changes | Required |
| No Moov/CheckAlt production transactions | Required |
| Provider + financial execution flags OFF | Required |
| Do not apply `64_financial_activation_grants.sql` | Required |
| Do not migrate/invalidate production passkeys | Required |
| Leave PR #125 untouched | Required |
| No PII / bank data / check images in Git evidence | Required |

## Baselines

| Artifact | Timestamp / identity |
|---|---|
| Production dump used for first AWS copy | `Migration/checksops_260901(1).backup` (2026-09-01, 49.1 MB) |
| First-copy restore status | `aws/db-copy/FIRST_COPY_STATUS.md` |
| Committed live catalog (Lovable inventory) | `aws/db-copy/LIVE_SOURCE_INVENTORY.md` |
| Storage COPY reconcile | `aws/storage/RECONCILE.json` (2026-09-02, 1,334 objects) |

## Phase map

### Phase 1 — Fresh production inventory

**Authoritative path:** operator-held READ-ONLY URI on an operator host (never paste into Cursor).  
Cloud Agents must not request/store the production DB password (`aws/db-copy/lib/live-access.mjs`).

Operator checklist:

1. Run sanitized catalog counts (tables/views/routines/triggers/RLS/auth.users/storage.objects) via Lovable SQL or `psql` RO.
2. `pg_dump -Fc --no-owner --no-acl` of public (+ required schemas per FIRST_COPY_PROCEDURE).
3. Upload to `s3://checksops-staging-privatefilesbucket-erzqsolpucjp/Migration/checksops_YYYYMMDD.backup` **without** overwriting `checksops_260901(1).backup`.
4. Confirm the S3 key in the PR thread.

Scripts/docs:

- `aws/db-copy/rehearsal/scripts/operator-fresh-dump.md`
- Committed inventory refresh target: `aws/db-copy/LIVE_SOURCE_INVENTORY.md`

### Phase 2 — Fresh migration rehearsal (staging)

Goal: bring a **rehearsal database** (recommended name `checksops_rehearsal_YYYYMMDD`) from empty/extensions → restored dump → post-restore stubs/grants, **without** destroying the live staging app DB `checksops` that holds Cognito identity overlays and UAT state.

Preserve on live `checksops` (do **not** blind overwrite):

- `public.identity_accounts` and Cognito pool/users
- Staging Lambda env / provider flags
- `aws_provider_sandbox_operations`
- Staging-only OTP/session tables if present
- RLS policies applied after first copy

Repeatable restore path (operator / VPC oneshot — same pattern as first copy):

1. Create DB `checksops_rehearsal_YYYYMMDD` on existing RDS instance.
2. Enable RDS-supported extensions (`aws/db-copy/sql/00_rds_supported_extensions.sql`).
3. `pg_restore` from the new S3 dump (ephemeral VPC Lambda; least-privilege role).
4. Apply auth stubs + readonly grants (`01_`, `02_` SQLs).
5. Run recon SQL against rehearsal DB.
6. Optionally merge identity mappings via explicit script (never set `application_user_id = cognito_sub`).

Storage delta:

- Use `aws/storage/copy-from-supabase.mjs` or `bridge-copy.mjs` with service role on operator host.
- Reconcile counts/bytes only; never commit object keys with customer paths.

### Phase 3 — Reconciliation

Automated (offline) tools in this PR:

| Script | Purpose |
|---|---|
| `rehearsal/oneshot/index.mjs` | In-VPC sanitized staging inventory |
| `rehearsal/scripts/reconcile-vs-baseline.mjs` | Staging vs Sept-1 dump counts/financial |
| `rehearsal/scripts/storage-delta-summary.mjs` | S3 aggregate delta vs Sept-1 COPY |

Required gates before any cutover consideration:

- 166 business tables present; row-count diff explained
- Financial aggregates match (report-only)
- PK set / tenant ownership checks
- FK orphan counts = 0 for critical edges
- `identity_accounts`: `cognito_sub ≠ application_user_id`; no unsafe equals
- Storage object counts + total bytes within agreed tolerance
- Zero unexpected duplicates / null regressions on required columns

### Phase 4 — Final cutover delta procedure (design only)

See `CUTOVER_DELTA_PROCEDURE.md` in this folder.

**Do not switch DNS, webhooks, or Auth.**

## Current rehearsal evidence (this PR)

See `MIGRATION_REHEARSAL_REPORT.md` and `analysis/*`.

## Scorecard

See report: overall **PARTIAL / NO-GO** until a fresh production dump is placed and restored into an isolated rehearsal database with full prod↔rehearsal reconciliation.
