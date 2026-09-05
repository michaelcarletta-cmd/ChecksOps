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
| Do not overwrite live AWS staging DB `checksops` | Required |

## Baselines

| Artifact | Timestamp / identity |
|---|---|
| Production dump used for first AWS copy | `Migration/checksops_260901(1).backup` (2026-09-01, 49.1 MB) |
| First-copy restore status | `aws/db-copy/FIRST_COPY_STATUS.md` |
| Committed live catalog (Lovable inventory) | `aws/db-copy/LIVE_SOURCE_INVENTORY.md` |
| Storage COPY reconcile | `aws/storage/RECONCILE.json` (2026-09-02, 1,334 objects) plus live bridge COPY 2026-09-05 (1,411 objects) |
| DB bridge recon | `DB_BRIDGE_RECONCILE.md` (2026-09-05) |

## Phase map

### Phase 1 — Validate the read-only DB bridge

Cloud Agents must not request/store the production DB password (`aws/db-copy/lib/live-access.mjs`). The temporary fail-closed Lovable DB bridge is the Cloud Agent read path:

`POST` `aws-staging-db-bridge` with `health` / `tables` / `schema` / `counts` / `rows` / `identity_map`.

Require `mode: read_only` and `writes`/`deletes`/`rpc`/`rawSql` all false. A fresh `pg_dump` is **not** required when the bridge supplies those actions.

Optional extra dump (not a blocker): `aws/db-copy/rehearsal/scripts/operator-fresh-dump.md`.

### Phase 2 — Authoritative production delta vs Sept. 1

Worker: `node aws/db-copy/rehearsal/scripts/bridge-db-rehearsal.mjs`

1. Keyset-page approved business tables (`keysOnly: true`).
2. Classify insert / update / delete / unchanged vs the Sept. 1 dump keys.
3. Fetch full rows only for reconstruct keys. Omit `[redacted]` secret columns; preserve SQL NULL.

### Phase 3 — Isolated rehearsal restore/sync

Goal: bring `checksops_rehearsal_YYYYMMDD` to current production application state **without** destroying live `checksops` (Cognito identity overlays and UAT).

This rehearsal used `CREATE DATABASE … TEMPLATE checksops` then overlay. Dump restore remains an optional alternative (PostgreSQL 18 `pg_restore` for dump v1.16).

Preserve on live `checksops`:

- `public.identity_accounts` and Cognito pool/users
- Staging Lambda env / provider flags
- `aws_provider_sandbox_operations`
- Staging-only OTP/session tables if present
- RLS policies applied after first copy

Storage delta (already PASS; rerun only for a final delta check):

- `node aws/db-copy/rehearsal/scripts/bridge-storage-copy.mjs`
- Leave both Lovable bridges deployed until final cutover rehearsal and final delta sync.

### Phase 4 — Reconciliation

| Script | Purpose |
|---|---|
| `rehearsal/scripts/bridge-db-rehearsal.mjs` | Live prod vs isolated rehearsal (counts/PK/financial/FK/identity) |
| `rehearsal/oneshot/index.mjs` | In-VPC sanitized staging inventory |
| `rehearsal/scripts/reconcile-vs-baseline.mjs` | Staging vs Sept-1 dump counts/financial |
| `rehearsal/scripts/storage-delta-summary.mjs` | S3 aggregate delta vs Sept-1 COPY |

Required gates before any cutover consideration:

- Business table counts match live production
- Financial aggregates match (report-only)
- PK set / tenant ownership checks
- FK orphan counts = 0 for critical edges
- Application-user UUIDs + membership/role relationships
- Storage object counts + total bytes exact
- Zero unexpected duplicates / null regressions on required columns
- Any production tables missing on staging have DDL applied (`financial_stepup_log`)

### Phase 5 — Final cutover delta procedure (design only)

See `CUTOVER_DELTA_PROCEDURE.md` in this folder.

**Do not switch DNS, webhooks, or Auth.**

## Current rehearsal evidence (this PR)

See `MIGRATION_REHEARSAL_REPORT.md`, `DB_BRIDGE_RECONCILE.md`, `STORAGE_COPY_RECONCILE.md`, and `analysis/*`.

Storage vs live production (2026-09-05): **PASS** — 1,411/1,411 objects, 2,565,912,220 bytes, 21 staging-only UAT keys left in place.

DB vs live production on isolated rehearsal (2026-09-05): migratable counts/financial/critical PKs/FKs **PASS**; `financial_stepup_log` DDL outstanding → overall **PARTIAL / NO-GO**. Bridges not torn down.

## Scorecard

See report: overall **PARTIAL / NO-GO** until `financial_stepup_log` DDL is applied and overlaid. Production cutover is **STOP FOR REVIEW**.
