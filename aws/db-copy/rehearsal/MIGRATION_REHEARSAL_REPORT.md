# Migration rehearsal report — PR #127

**Generated:** 2026-09-05T03:15:25Z (UTC) — DB bridge recon + storage COPY  
**Branch:** `cursor/migration-rehearsal-cutover-c8f0`  
**Objective:** Prove production → AWS staging data/storage migration is accurate and repeatable **before** cutover.  
**Production cutover performed:** **NO**

## Safety attestation

| Control | Result |
|---|---|
| Production Supabase modified | **NO** (`productionSupabaseChanged: false`) |
| DNS / webhooks / Auth changed | **NO** |
| Moov/CheckAlt/Plaid execution | **NO** (flags OFF) |
| `64_financial_activation_grants.sql` applied | **NO** |
| Production passkeys migrated/invalidated | **NO** |
| PR #125 touched | **NO** |
| PII/credentials in committed evidence | **NO** (counts/aggregates/fingerprints only) |
| Temporary DB + Storage bridges left deployed | **YES** |

Provider flags on `checksops-staging-api` at report time: all execution flags **`false`**.

## Production baseline + live delta path

| Item | Value |
|---|---|
| Baseline dump | `s3://…/Migration/checksops_260901(1).backup` |
| Baseline timestamp | **2026-09-01T20:36:44Z** |
| Size | 49,100,401 bytes |
| Authoritative live path | read-only `aws-staging-db-bridge` (fail-closed) |
| Isolated rehearsal DB | `checksops_rehearsal_20260905` |
| Live staging DB `checksops` | **not overwritten** |

A fresh `pg_dump` is **not required** while the bridge provides health + approved tables + schemas + counts + keyset paging + reconstruct rows. Dump remains an optional extra snapshot.

Evidence: `DB_BRIDGE_RECONCILE.md`, `analysis/db_bridge_phase1.json`, `analysis/db_bridge_reconcile.json`.

## Phase 1 — Bridge validation

| Check | Result |
|---|---|
| HTTP health | **PASS** |
| `mode: read_only` | **PASS** |
| writes / deletes / rpc / rawSql | **all false** |
| Approved business tables | **161** |
| Excluded secret/token tables | 8 (tokens/credentials/passkeys/PostGIS catalog) |
| Current production row sum | **12,397** |

## Phase 2 — Production delta vs Sept. 1

| Totals | Inserted | Updated | Deleted | Unchanged |
|---|---:|---:|---:|---:|
| All approved business tables | **632** | **66** | **3** | **10914** |

Full table-level I/U/D is in `DB_BRIDGE_RECONCILE.md`. Secret columns were omitted (`[redacted]` not written; SQL NULL preserved).

## Phase 3 — Isolated rehearsal overlay

`CREATE DATABASE checksops_rehearsal_20260905 TEMPLATE checksops`, then replace migratable business tables with current production rows.

| Step | Result |
|---|---|
| Overlay | **PASS** — 11,610 upserts |
| Skipped | `financial_stepup_log` (missing on staging schema; 2 production rows) |
| Live `checksops` mutated | **NO** |

## Phase 4 — Rehearsal vs live production

| Gate | Result |
|---|---|
| Table row counts (166 recon SQL tables) | **PASS** (0 mismatches) |
| Primary-key fingerprints (critical tables) | **PASS** |
| Tenant ownership | **PASS** (6 / 6) |
| Checks / claims / deposits / disbursements | **PASS** (counts + PK fingerprints) |
| Financial aggregates (report-only) | **PASS** (exact match; check_intake 1417824.60, homeowner_ledger 3154787.52) |
| Application-user UUIDs / identity_map | **PASS** (8 profiles, 10 user_roles, 7 tenant_users) |
| Membership / role relationships | **PASS** |
| FK integrity | **PASS** (0 orphans; 0 duplicate user_roles) |
| Required-null regressions | **PASS** |

## Phase 5 — Storage (already completed; not rerun)

| Metric | After live prod COPY |
|---|---|
| Production objects on S3 | **1,411** (exact match) |
| Production bytes | **2,565,912,220** (exact match) |
| Newly copied | 77 |
| Existing verified (hash match) | 1,334 |
| Missing / failed / mismatched | **0 / 0 / 0** |
| Staging-only UAT | **21** left in place |

Evidence: `STORAGE_COPY_RECONCILE.md`, `analysis/storage_copy_reconcile.json` (no object keys).

## Discrepancies & remediation

| Discrepancy | Remediation |
|---|---|
| `financial_stepup_log` is in live production (2 rows) but has no table on staging RDS | Apply production DDL on rehearsal/staging, then overlay the 2 rows |
| TEMPLATE clone copied staging-only `identity_accounts` onto rehearsal | Expected. Do not treat as production data. Live `checksops` identity was not modified |
| Production `profiles.preferred_auth_method` is not on staging schema | Skip on overlay (done). Add column via staging migration if the app requires it |
| Staging S3 +21 UAT objects | Identified separately; left in place |

## Repeatable commands (this PR)

```bash
# Live production Storage COPY + recon (token from Secrets Manager; never commit it):
node aws/db-copy/rehearsal/scripts/bridge-storage-copy.mjs

# Live production DB bridge delta + isolated rehearsal overlay (does not overwrite checksops):
node aws/db-copy/rehearsal/scripts/bridge-db-rehearsal.mjs
# Resume Lambda overlay/recon only:
node aws/db-copy/rehearsal/scripts/bridge-db-rehearsal.mjs --resume-lambda
```

Optional extra dump: `scripts/operator-fresh-dump.md`  
Cutover design: `CUTOVER_DELTA_PROCEDURE.md`

## Estimated final cutover / write-freeze

**~45–110 minutes** to freeze, capture bridge delta (or dump), overlay/restore, recon, and storage delta. This rehearsal did **not** freeze production. Bridge keyset paging + overlay of ~12k rows completed on the order of **minutes**.

## Rollback

Before DNS/webhook switch: keep Supabase as system of record; drop `checksops_rehearsal_*` only; leave S3 append-only; leave staging Cognito/`identity_accounts` on live `checksops`. Details in `CUTOVER_DELTA_PROCEDURE.md`.

## Scorecard

| Area | Grade |
|---|---|
| Safety / non-destructive controls | **PASS** |
| DB bridge fail-closed validation | **PASS** |
| Authoritative production delta vs Sept. 1 | **PASS** |
| Isolated rehearsal overlay | **PASS** (1 new table skipped) |
| Prod↔rehearsal recon (counts/PK/financial/FK/identity) | **PASS** on migratable tables |
| New-table DDL (`financial_stepup_log`) | **PARTIAL** (outstanding) |
| Storage delta vs live prod | **PASS** (1,411 objects, exact bytes; 21 UAT extras left in place) |
| Cutover delta procedure (design) | **PASS** |
| DNS/webhook/Auth switch | **N/A — not performed** |

### Overall: **PARTIAL**

### Data migration readiness: **NO-GO**

**Reason:** Storage vs live production is **PASS**. Migratable application data on isolated rehearsal matches live production (counts, critical PK sets, financial aggregates, identity UUIDs, memberships, FKs). Remaining blocker is production DDL for `financial_stepup_log` (2 rows) plus STOP FOR REVIEW. Live `checksops` was not overwritten.

**GO criteria for a follow-up (still not cutover):**

1. Apply `financial_stepup_log` (and optional `profiles.preferred_auth_method`) DDL on rehearsal/staging
2. Overlay the 2 skipped rows and re-run recon
3. Storage inventory prod vs S3 PASS — **done 2026-09-05**
4. Timed write-freeze measurement on the next delta capture
5. Separate future PR for DNS/webhook/auth — not this PR

## STOP

**STOP FOR REVIEW.** No production cutover. No DNS/webhook/Auth/Moov/CheckAlt/provider-flag changes. Both temporary Lovable bridges remain deployed until final cutover rehearsal and final delta sync are complete.
