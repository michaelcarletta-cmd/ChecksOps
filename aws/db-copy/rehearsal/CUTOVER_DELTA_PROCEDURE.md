# Final cutover delta procedure (design + dry-run only)

This document defines the repeatable last-mile procedure for a future production cutover.  
**This PR does not execute cutover.**

The ordered night-of sequence, rollback, webhook plan, and bridge teardown live in `aws/cutover/`. This file remains the DB/storage delta design used by PR #127.

## What must be frozen / read-only during final cutover

1. **Production Supabase writes** — application write-freeze (maintenance mode or feature flag) so no new checks/deposits/disbursements/ledger rows or storage objects land mid-delta.
2. **Production Auth** — no password resets / invites that would desync Cognito mapping work already staged.
3. **Provider webhooks** — keep production Moov/CheckAlt/Plaid webhooks on Supabase until validation gates pass; do **not** redirect during delta capture.
4. **AWS staging provider flags** — remain OFF (`AWS_PROVIDER_EXECUTION_ENABLED`, `AWS_MOOV_ENABLED`, `AWS_CHECKALT_ENABLED`, `AWS_PLAID_ENABLED`, `AWS_FINANCIAL_PERMISSIONS_ACTIVATED`).
5. **DNS** — no Route53/CloudFront apex cut until post-delta gates are green.

## How the last production delta is captured

Preferred path (this rehearsal): the temporary read-only DB bridge. A fresh dump is **optional**, not a blocker, while the bridge remains deployed and fail-closed.

1. Enter write-freeze (T0).
2. `POST` `health` on `aws-staging-db-bridge`; require `mode: read_only` and writes/deletes/rpc/rawSql false.
3. `POST` `tables`, `schema`, `counts`.
4. For each approved table, `POST` `rows` with `keysOnly: true` and stable keyset paging (`after` = last `nextAfter`).
5. Classify insert / update / delete vs the last rehearsal overlay (or vs the Sept. 1 dump keys).
6. Fetch full rows only for inserted + updated PKs. Strip `[redacted]` secret columns; preserve SQL NULL.
7. `POST` `identity_map` (sanitize emails/names in any stored report).
8. Upload overlay JSON to a private S3 prefix. Record overlay SHA-256.
9. Optional extra: operator READ-ONLY `pg_dump -Fc` → `Migration/checksops_cutover_YYYYmmdd_HHMM.backup` (PostgreSQL 18 `pg_restore` for dump v1.16).
10. Operator runs storage inventory (object count + bytes per bucket) without downloading customer documents to Git.
11. Record Auth user count + email→UUID map hashes (no password hashes).
12. Capture provider webhook cursor/high-water marks (IDs only) for replay planning — still do not redirect.

## Order of migration (cutover night)

| Step | Action | Rollback point |
|---|---|---|
| 1 | Write-freeze production | Abort freeze; resume prod |
| 2 | Final bridge delta (and optional dump) + storage inventory | N/A (read-only) |
| 3 | Overlay/restore into isolated RDS rehearsal DB (or swap-ready DB) | Drop rehearsal DB |
| 4 | Reconcile counts/financial/FK/identity | Drop rehearsal DB |
| 5 | Storage delta COPY to S3 (append-only) | Leave extras; do not delete prod |
| 6 | Cognito identity delta for new users only | Disable new Cognito users |
| 7 | Point staging API at reconciled DB (if rehearsal DB becomes target) | Point back to prior DB name |
| 8 | Validation gates (below) | Stay on Supabase |
| 9 | **Future:** DNS + webhook switch (out of scope for this PR) | DNS/webhook rollback |

## Expected downtime / write-freeze window

| Segment | Estimate |
|---|---|
| Announce + enable write-freeze | 5 min (operator) |
| Bridge keyset + reconstruct rows | **2 min 55 s** measured |
| Upload overlay JSON to S3 | **1 min 52 s** measured |
| Isolated overlay / restore | **42 s** measured (TEMPLATE clone + 11,614 upserts) |
| Automated recon + financial gates | **1.5 s** measured |
| Storage inventory | **7 min 53 s** measured |
| Storage delta COPY (new objects only) | **0** this drill; full re-verify of 1,411 objects **11 min 16 s** (pre-freeze) |
| Cognito identity delta (8 users, not imported) | **~9 s** estimated |
| **Total write-freeze (DB+storage ready, pre-DNS)** | **~25–35 min** freeze-critical path (parallel DB capture + storage inventory); **45 min** customer-facing hold. See `WRITE_FREEZE_TIMING.md`. |

DNS/webhook switch adds a separate controlled window and is **not** authorized by this PR.

## Validation gates before DNS/webhook switch

All must be PASS:

1. Row counts: every business table within agreed delta (ideally exact match to final dump).
2. Financial aggregates: exact match (report-only SQL).
3. Critical FK orphan counts = 0.
4. Tenants count + ownership intact.
5. Identity: all active users mapped; `cognito_sub ≠ application_user_id`.
6. Storage: object counts + bytes match inventory (±0 for cutover).
7. Provider flags still OFF; no production transaction executed on AWS.
8. Smoke: staging HTTPS login + read paths for CheckOps / WhiteLabel / MortgageOps.
9. Rollback drill documented and still valid.

## Rollback point and procedure

**Rollback point:** any time before DNS/webhook switch — production Supabase remains system of record.

Procedure:

1. Keep/restore DNS to Lovable/Supabase frontend+API.
2. Do not redirect provider webhooks.
3. Leave AWS S3 objects in place (append-only; harmless).
4. Drop or rename failed rehearsal DB; keep prior `checksops` staging DB intact.
5. Disable any Cognito users created only for the failed cutover wave.
6. Lift production write-freeze only after confirming Supabase health.

After DNS switch (future PR only): rollback is DNS revert + webhook revert within the monitored window; AWS writes during that window need explicit reconciliation — hence flags stay OFF until confidence is high.

## Dry-run status (this PR)

| Item | Status |
|---|---|
| Procedure written | PASS |
| Staging inventory vs Sept-1 baseline | PASS (tooling + evidence) |
| DB bridge validation + Sept. 1 → live delta | PASS (632 inserted / 66 updated / 3 deleted) |
| Isolated rehearsal overlay vs live production | **PASS** — counts/financial/PKs/FKs/`financial_stepup_log` 2/2 |
| Storage COPY vs live production | PASS (1,411 objects) |
| Timed write-freeze measurement | **Measured 2026-09-06** (production not frozen). DB **~6 min**; storage inventory **~8 min**; full re-verify **~11 min** / 0 new copies. `WRITE_FREEZE_TIMING.md` |
| DNS/webhook switch | **NOT PERFORMED** (forbidden) |
