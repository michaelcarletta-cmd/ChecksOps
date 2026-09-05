# Migration rehearsal report — PR #127

**Generated:** 2026-09-05T01:57:08Z (UTC) — storage COPY/recon updated  
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
| PII/credentials in committed evidence | **NO** (counts/aggregates only) |

Provider flags on `checksops-staging-api` at report time: all execution flags **`false`**.

## Production baseline

| Item | Value |
|---|---|
| Baseline dump | `s3://…/Migration/checksops_260901(1).backup` |
| Baseline timestamp | **2026-09-01T20:36:44Z** |
| Size | 49,100,401 bytes |
| First-copy restore | Database `checksops` on staging RDS (see `FIRST_COPY_STATUS.md`) |
| Committed live catalog | `LIVE_SOURCE_INVENTORY.md` (166 tables / 20 views / 960 fns / 211 triggers / 380 RLS / 9 auth users / 1,335 storage objects) |

### Fresh production inventory (Phase 1)

| Check | Status |
|---|---|
| New dump newer than 2026-09-01 in `Migration/` | **FAIL / BLOCKED** — only `checksops_260901(1).backup` present |
| Updated Lovable catalog vs Sept-1 inventory | **BLOCKED** — Cloud Agent has no production RO URI (by policy) |
| Operator dump requested | **YES** — external action `fresh-prod-dump-for-rehearsal` |

**Changes since Sept-1 cannot be fully enumerated from live production in this agent.** Staging-side drift vs the Sept-1 dump **is** measured below (includes staging UAT writes, not necessarily production).

## Source / target inventories

### Target — AWS staging DB `checksops` (fresh oneshot 2026-09-04)

| Metric | Sept-1 restore / live inventory | Staging now |
|---|---|---|
| Public base tables | 166 (business) / 166 restored | **180** (166 business + staging-only) |
| Views | 20 live / 22 restored | **22** |
| Routines | 960 live / 965 restored | **1023** |
| Triggers (information_schema) | 211 | **211** |
| RLS policies | 380 live / 0 on first restore | **307** (post-restore RLS work) |
| Business tables counted | 166 | **166** (recon SQL) |
| Tables with rows | 100 | **103** |
| `identity_accounts` | n/a at dump | **10** (9 active, 1 pending, 0 unsafe sub=app) |
| Tenants | 6 | **6** |
| Profiles | 8 | **9** |
| User roles | 10 | **11** (includes staging `mortgage_agent` hires) |

Financial aggregates (report-only) — **exact match** to Sept-1 dump artifacts:

| Metric | Value |
|---|---|
| check_intake_amount | 1317000.53 |
| deposit_items_amount | 963972.98 |
| checkalt_deposits_amount | 380333.17 |
| homeowner_ledger_amount | 2977337.23 |
| (all metrics in financial recon) | **0 diffs** vs baseline JSON |

FK orphan spot-checks: endorsements/deposits/disbursements/identity → **0**.

Evidence: `analysis/staging_inventory.json`, `analysis/staging_vs_baseline.json`.

### Target — staging S3 `files/`

| Metric | Sept-1 COPY | Pre-COPY (this PR) | After live prod COPY | Notes |
|---| ---:| ---:| ---:|---|
| `files/` objects | 1,334 | 1,355 | **1,432** | 1,411 production + 21 staging-only UAT |
| Production objects on S3 | 1,334 | n/a | **1,411** | Exact match to live inventory |
| Production bytes | 2,501,472,395 | n/a | **2,565,912,220** | Exact match to live inventory |
| Staging-only UAT | n/a | 21 | **21** (left in place) | 17 claim-files + 4 homeowner-uploads |

Live production inventory (bridge, 2026-09-05): **1,411** objects / **2,565,912,220** bytes. COPY: 77 new puts, 1,334 SHA-256 verified existing, 0 failed, 0 conflicts, 0 missing.

Evidence: `STORAGE_COPY_RECONCILE.md`, `analysis/storage_copy_reconcile.json` (no object keys).

## Reconciliation results

### Staging vs Sept-1 dump (complete)

| Gate | Result |
|---|---|
| Financial aggregates | **PASS** (0 diffs) |
| Critical FK orphans | **PASS** (0) |
| Identity unsafe sub=app | **PASS** (0) |
| Business row counts | **PARTIAL** — 13 tables differ (staging UAT growth; see diffs JSON) |
| Catalog parity to live prod | **UNKNOWN** — no fresh prod DB dump |
| Storage byte/count vs live prod | **PASS** — 1,411 / 1,411 objects, 2,565,912,220 bytes, 0 missing/failed/mismatched |

Row-count deltas (staging − baseline), sanitized:

| Table | Δ rows |
|---|---|
| tenant_usage_logs | +14 |
| check_messages | +11 |
| check_audit_log | +10 |
| homeowner_ledger_events | +8 |
| homeowner_check_uploads | +3 |
| notification_preferences | +2 |
| loss_draft_audit_log | +2 |
| audit_logs / check_cases / profiles / role_version_tracker / user_roles / user_sessions | +1 each |

These are consistent with **staging write-path / Class A / hire UAT**, not proof of production drift.

### Production ↔ staging (required for PASS)

| Gate | Result |
|---|---|
| Fresh dump restore into isolated rehearsal DB | **NOT RUN** (blocked on dump) |
| Prod vs rehearsal row counts | **NOT RUN** |
| Prod vs rehearsal financial aggregates | **NOT RUN** |
| Prod vs S3 storage inventory | **PASS** — see `STORAGE_COPY_RECONCILE.md` |
| Auth user delta → Cognito | **NOT RUN** |

## Discrepancies & remediation

| Discrepancy | Remediation |
|---|---|
| No dump newer than 2026-09-01 | Operator places `Migration/checksops_YYYYMMDD.backup` (see `scripts/operator-fresh-dump.md`) |
| Cannot query live prod from Cloud Agent | Use Lovable RO / operator host; update `LIVE_SOURCE_INVENTORY.md` with counts only |
| Staging DB has UAT overlays | Rehearse restore into **`checksops_rehearsal_*`**, not by destroying live `checksops` identity |
| Staging S3 +21 UAT objects vs Sept-1 | Identified separately; left in place. Live prod COPY added 77 objects; 1,334 existing production keys hash-verified |
| First-copy CLI still refuses dump/restore execute | Keep guard; use ephemeral VPC oneshot (same as #71) for approved restores only |

# Repeatable commands (this PR)

```bash
# Staging sanitized inventory (deploy oneshot from rehearsal/oneshot, invoke, delete)
# See README.md — do not leave oneshot Lambda around.

# Offline diffs after inventory JSON exists:
node aws/db-copy/rehearsal/scripts/reconcile-vs-baseline.mjs
node aws/db-copy/rehearsal/scripts/storage-delta-summary.mjs

# Live production Storage COPY + recon (token from Secrets Manager; never commit it):
node aws/db-copy/rehearsal/scripts/bridge-storage-copy.mjs
```

Operator dump: `scripts/operator-fresh-dump.md`  
Cutover design: `CUTOVER_DELTA_PROCEDURE.md`

## Estimated final cutover / write-freeze

**~45–110 minutes** write-freeze to reach pre-DNS readiness after a timed full rehearsal restore (see cutover doc). **Not yet measured** on a fresh dump.

## Rollback

Before DNS/webhook switch: keep Supabase as system of record; drop rehearsal DB; leave S3 append-only; disable cutover-only Cognito users. Details in `CUTOVER_DELTA_PROCEDURE.md`.

## Scorecard

| Area | Grade |
|---|---|
| Safety / non-destructive controls | **PASS** |
| Tooling for inventory + offline recon | **PASS** |
| Staging vs Sept-1 baseline recon | **PASS** (financial) / **PARTIAL** (row counts explained) |
| Fresh production inventory | **FAIL** (blocked) |
| Fresh dump → isolated restore rehearsal | **FAIL** (blocked) |
| Prod↔AWS automated reconciliation | **FAIL** (blocked) |
| Storage delta vs live prod | **PASS** (1,411 objects, exact bytes, 0 missing/failed/mismatched; 21 UAT extras left in place) |
| Cutover delta procedure (design) | **PASS** |
| Cutover delta timed dry-run | **FAIL** (blocked) |
| DNS/webhook/Auth switch | **N/A — not performed** |

### Overall: **PARTIAL**

### Data migration readiness: **NO-GO**

**Reason:** Storage vs live production inventory is **PASS**. Database cutover readiness is still **NO-GO** until a fresh production dump is restored into an isolated `checksops_rehearsal_*` database and reconciled. Staging DB remains a Sept-1 baseline plus intentional AWS overlays.

**GO criteria for a follow-up:**

1. Fresh `Migration/checksops_YYYYMMDD.backup` uploaded  
2. Restore into `checksops_rehearsal_YYYYMMDD`  
3. Prod dump vs rehearsal: row counts + financial aggregates PASS  
4. Storage inventory prod vs S3 PASS — **done 2026-09-05**  
5. Identity delta plan for new auth users documented with zero unsafe mappings  
6. Timed restore measured → update write-freeze estimate  

## STOP

**STOP FOR REVIEW.** Storage COPY + recon is **PASS**. No production cutover. No DNS/webhook changes. Lovable bridge remains deployed for the final delta sync. Awaiting operator fresh dump to finish DB rehearsal.
