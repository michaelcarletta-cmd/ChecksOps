# Final cutover delta procedure (design + dry-run only)

This document defines the repeatable last-mile procedure for a future production cutover.  
**This PR does not execute cutover.**

## What must be frozen / read-only during final cutover

1. **Production Supabase writes** — application write-freeze (maintenance mode or feature flag) so no new checks/deposits/disbursements/ledger rows or storage objects land mid-delta.
2. **Production Auth** — no password resets / invites that would desync Cognito mapping work already staged.
3. **Provider webhooks** — keep production Moov/CheckAlt/Plaid webhooks on Supabase until validation gates pass; do **not** redirect during delta capture.
4. **AWS staging provider flags** — remain OFF (`AWS_PROVIDER_EXECUTION_ENABLED`, `AWS_MOOV_ENABLED`, `AWS_CHECKALT_ENABLED`, `AWS_PLAID_ENABLED`, `AWS_FINANCIAL_PERMISSIONS_ACTIVATED`).
5. **DNS** — no Route53/CloudFront apex cut until post-delta gates are green.

## How the last production delta is captured

1. Enter write-freeze (T0).
2. Operator runs READ-ONLY `pg_dump -Fc` → upload `Migration/checksops_cutover_YYYYmmdd_HHMM.backup`.
3. Operator runs storage inventory (object count + bytes per bucket) without downloading customer documents to Git.
4. Record Auth user count + email→UUID map hashes (no password hashes).
5. Capture provider webhook cursor/high-water marks (IDs only) for replay planning — still do not redirect.

## Order of migration (cutover night)

| Step | Action | Rollback point |
|---|---|---|
| 1 | Write-freeze production | Abort freeze; resume prod |
| 2 | Final dump + storage inventory | N/A (read-only) |
| 3 | Restore dump into isolated RDS rehearsal DB (or swap-ready DB) | Drop rehearsal DB |
| 4 | Reconcile counts/financial/FK/identity | Drop rehearsal DB |
| 5 | Storage delta COPY to S3 (append-only) | Leave extras; do not delete prod |
| 6 | Cognito identity delta for new users only | Disable new Cognito users |
| 7 | Point staging API at reconciled DB (if rehearsal DB becomes target) | Point back to prior DB name |
| 8 | Validation gates (below) | Stay on Supabase |
| 9 | **Future:** DNS + webhook switch (out of scope for this PR) | DNS/webhook rollback |

## Expected downtime / write-freeze window

| Segment | Estimate |
|---|---|
| Announce + enable write-freeze | 5–10 min |
| Final `pg_dump` of ~50–100 MB class DB | 5–15 min (measure on rehearsal) |
| Upload to S3 | 2–5 min |
| VPC restore into empty DB | 10–25 min |
| Automated recon + financial gates | 5–10 min |
| Storage delta COPY (incremental objects only) | 5–30 min (depends on delta size) |
| Cognito identity delta | 5–15 min |
| **Total write-freeze (DB+storage ready, pre-DNS)** | **~45–110 min** (refine after first full rehearsal restore) |

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
| Fresh production dump restore rehearsal | **BLOCKED** — awaiting operator dump in S3 |
| Timed write-freeze measurement on fresh dump | **BLOCKED** (depends on above) |
| DNS/webhook switch | **NOT PERFORMED** (forbidden) |
