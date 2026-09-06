# Timed freeze-free cutover rehearsal

**STOP FOR REVIEW.** Production was **not** frozen. No DNS, auth import, webhooks, flags, grants, or bridge teardown.

Audit: 2026-09-06  
Rehearsal DB: `checksops_rehearsal_20260906` (disposable; live `checksops` not overwritten)  
Evidence: `analysis/write_freeze_timing.json`, `analysis/db_bridge_reconcile.json`, `analysis/storage_copy_reconcile.json`

## Safety

| Control | Result |
|---|---|
| Production write-freeze | **NO** (measurement only) |
| Production Supabase writes | **NO** (read-only DB + storage bridges) |
| Cognito import | **NO** (`--apply` refused; pool still 0 users) |
| DNS / CloudFront aliases | **NO** (apex/`www` still `185.158.133.1`) |
| `.env.production` | unchanged (Supabase) |
| Moov / CheckAlt / execution flags | still `false` |
| Financial grants | not applied |
| Bridges removed | **NO** |
| Live staging `checksops` data overwritten | **NO** (`/db-health` still `checksops`, `transactionReadOnly=on`) |

## Measured durations

Clock source: wall-clock `elapsedMs` on existing rehearsal workers. DB used `--skip-baseline-dump` (T0 overlay is `replaceAll` of live rows; Sept 1 `pg_restore` key extract is not on the freeze clock and was unavailable in this VM).

| Phase | Measured | Notes |
|---|---|---|
| 1. Final DB delta capture (keys + full rows, 161 tables / 12,399 rows) | **2 min 55 s** | Read-only DB bridge |
| 1b. Overlay JSON upload to private S3 | **1 min 52 s** | 161 table payloads |
| 2. DB overlay/restore (`CREATE DATABASE … TEMPLATE checksops` + apply 11,614 upserts) | **42 s** (restore **8 s** + apply **35 s**) | Isolated `checksops_rehearsal_20260906` |
| 3. DB reconciliation (counts / PK / financial / FK / identity) | **1.5 s** | All gates **PASS** |
| 4a. Storage inventory | **7 min 53 s** | 15 pages; bridge re-walks every bucket per page |
| 4b. Storage COPY + hash recon | **11 min 16 s** | **0 new** objects; **1,411/1,411** existing verified; 2,565,912,220 bytes; 0 missing/failed/mismatched |
| 5. Identity prep (no import) | **dry-run 24 ms**; Cognito RTT **~575 ms**; **~9 s estimated** for eight `AdminCreateUser` + password calls | Production pool still **0 users** |
| Pack/ensure oneshot Lambda | **25 s** | **Pre-freeze** (not on T0 clock) |
| T4 smoke probe (`/health` + `/db-health`) | **~1–2 s** automated | Budget **10 min** for human EMAIL_OTP across three products |

Storage result **PASS**. Staging-only extras **28** left in place (not deleted). DB recon **PASS** (financial aggregates matched, including check_intake `1417824.60` and homeowner_ledger `3154787.52`).

## Realistic T0 → T6 maintenance window

**25–35 minutes** of freeze if we run the freeze-critical path only (below), plus a 5-minute announce/enable step (**~30–40 minutes** operator clock).

Assumptions for that band:

- Oneshot Lambda is packed **before** T0
- Storage full hash re-verify of 2.5 GB is **not** repeated during freeze (it just proved 0 drift)
- After freeze: one storage inventory + COPY of **new** objects only (this drill: 0 new, so inventory-dominated)
- DB capture and storage inventory run **in parallel**
- Identity `--apply` for eight users (~1 minute with human confirm)
- T4 API attach + human OTP smoke: 10 minutes
- Flags stay **false**; no webhook redirect; no CheckAlt/Moov enable
- T6 DNS itself is after this window (Cloudflare TTL extra)

Sequential worst case **on this tooling**, including a full storage re-download/verify during freeze: **~6 min DB + ~19 min storage + ~1 min identity + ~10 min T4 ≈ 36 minutes**, plus 5 minutes to enable freeze ≈ **~41 minutes**.

## Recommended customer-facing window

**Hold 45 minutes** on the maintenance page.

**Calendar hold 60 minutes** so one inventory retry or a small storage delta still fits. The old **45–110** band is no longer the planning number; 110 minutes is slack, not a measurement.

Do not advertise a sub-20-minute window: the storage bridge inventories by re-walking all buckets on every page (~30 s even for `limit=1`).

## What can run before write-freeze (shortens downtime)

| Work | Freeze savings |
|---|---|
| Pack/ensure `checksops-staging-rehearsal-oneshot` Lambda | **25 s** off T0 |
| Identity dry-run + payload review (no `AdminCreateUser`) | **~1 min** of confusion, not clock |
| Full storage hash verify (this drill: 11 min, 0 new) | Avoids 11 min on the freeze clock |
| Pre-freeze storage inventory as a baseline | Still need a **post-freeze** inventory; saves only surprise |
| Lower Cloudflare TTL, ACM attach with aliases still 0, passkey comms, Moov dual-run (dry-run) | Not on the DB/storage clock |
| Sept 1 dump `pg_restore` key extract | **Do not** put on T0; overlay is full replace |

**Must wait for freeze:** live DB keyset + full-row capture, isolated restore/overlay/recon, post-freeze storage inventory + COPY of new keys, identity `--apply`, T4 API point + smoke, then T6 DNS.

## Best cutover window

**Weekend off-hours, US Eastern**, with a **60-minute calendar hold** and a **45-minute** customer maintenance message.

Prefer Saturday early morning or Sunday evening over Monday morning (check-deposit volume). Keep `AWS_CHECKALT_ENABLED=false` and all provider/financial flags false. CheckAlt enable remains a later night.

Production was not frozen for this drill, so a few rows could have landed during capture; recon still **PASS**. On T0, freeze first, then capture.

## STOP

**STOP FOR REVIEW.** No T0 selected. No DNS/auth/import/webhook/flag/grant/bridge action performed.
