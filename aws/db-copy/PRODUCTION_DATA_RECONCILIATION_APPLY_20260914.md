# Production data reconciliation APPLY — Freedom Adjustment only — 2026-09-14

**Mode: CONTROLLED WRITE.** This document records the apply of the accepted
`RECONCILIATION REQUIRED` verdict from
`aws/db-copy/PRODUCTION_DATA_RECONCILIATION_20260914.md`. Scope is the
identified Freedom Adjustment production delta only. No full database restore.
No Moov/CheckAlt API calls. No webhook destination changes. No SPA deploy.

## Verdict

**RECONCILIATION PASS — READY FOR PROVIDER/WEBHOOK CUTOVER**

STOP after this validation. Do **not** change Moov or CheckAlt webhook
destinations yet. Do **not** deploy the SPA.

## 0. Preconditions that were re-verified immediately before write

1. Re-read every in-scope Supabase source row and AWS target row.
2. Compared the live delta to the 10:25 UTC report snapshot.
3. Searched for additional production writes after the snapshot.
4. Verified IDs, tenant ownership, and FK relationships for every row that
   would be inserted or updated.
5. Confirmed the target tenant is Freedom Adjustment
   `2eff5f1a-929d-4ce3-9a8b-cd96b98df42a`.
6. Explicitly excluded Condition One Commercial / test / UAT
   (`4f172140-f57a-4744-8050-95f4f07b13b4`).
7. Explicitly protected today's repaired `identity_accounts.cognito_sub`
   values. The identity table was not in the write set.

Preflight result: **all 15 in-scope tables still matched the report
snapshot**. No additional post-snapshot production writes were found. The
delta had not materially changed. Evidence:
`aws/db-copy/reconciliation-20260914/apply/preflight_delta.json`.

## 1. What was applied

### 1.1 Storage — 3 Freedom Adjustment objects

Signed from live Supabase via `aws-staging-storage-bridge` (`sign` only) and
PUT to `checksops-staging-privatefilesbucket-erzqsolpucjp` under the existing
production layout `files/{bucket}/{path}`. No existing AWS objects were
overwritten.

| AWS key | bytes | sha256 |
|---|---|---|
| `files/claim-files/checks/7dbb3009-f059-4767-b5dc-1c5c72379330/unclaimed/1785161226836_back_IMG_0978_cropped_endorsed_1789057905238.svg` | 791058 | `a3a4da2bd41d138a3369bea1c5807380858cd04d1bf64405ea77bc04a33ca7f1` |
| `files/claim-files/checks/7dbb3009-f059-4767-b5dc-1c5c72379330/unclaimed/1788459141955_front_IMG_1183_cropped.checkalt.jpg` | 278787 | `5975d95d9632d952045035c526ef824238eaf862727479c3565f87ac105d9dfb` |
| `files/claim-files/checks/7dbb3009-f059-4767-b5dc-1c5c72379330/unclaimed/endorsed_deposit_18vd.checkalt.jpg` | 247060 | `24007949bd8af25248f7ce162f70c32377c9bc2749a852c3ecb821d84a1e6cb2` |

### 1.2 Database — guarded transaction

Temporary Lambda `checksops-cursor-recon-apply-temp` (now deleted) applied
57 operations: dry-run `ROLLBACK` first (11 updated + 46 inserted), then
live `COMMIT` with the same counts at **2026-09-14T11:10:52.225Z**.

Applied:

- UPDATE `check_endorsements` `3d1565b9-ac95-427e-a694-2e5034030a1d`
  `pending` → `signed` (token / redacted columns skipped).
- UPDATE `check_intake_items` `7d62ea7c…` ($413.03), `623442f0…` ($9,984.11
  CheckAlt paths), plus the report-authorized revert of AWS test mutations
  on `64fca2df…` and `c7ea8b6a…` (`c7ea8b6a` status back to `needs_review`).
- INSERT endorsement / audit / ledger / `check_audit` rows for the Sept 10
  signing.
- UPDATE 3 `stakeholder_accounts` and 2 `external_payment_recipients`
  (`62a858ff…` → `ready`).
- INSERT 2 verification-log, 6 `email_send_log`, 19
  `payment_webhook_events`, 11 `payment_event_log`.
- UPDATE `tenant_email_settings` `20ea4b40…` AWS `failed` → SB `verified`.

Guards: `SELECT … FOR UPDATE`; expected AWS sentinel had to match;
redacted/token columns never written; `tenant_id` never overwritten on
UPDATE; Condition One Commercial hard-refused; identity / membership
fingerprints compared before `COMMIT`.

Trigger note: updating `check_intake_items` first fired a payee-mirror
trigger that bumped `check_endorsements.updated_at` in-transaction and
failed the sentinel. Fix: apply the endorsement UPDATE **before** the
intake UPDATE so the trigger preserves `status IN ('signed','waived')`.

## 2. Intentionally not applied

- `payment_provider_accounts` `26c2dbb1…`: same immutable Moov id
  `60922058-7eca-4889-81dd-5720d7b9de96`. AWS readiness is **more** complete
  (`overall: ready`, `canMoveMoney: true`) than Supabase (`pending` / false).
  Overwriting would regress AWS. The report did not prove Supabase
  authoritative for this cache row.
- `check_intake_items` `33a674e6…` ($5,533.87): AWS-newer Freedom Adjustment
  row. The report did **not** prove Supabase authoritative.
- All Condition One Commercial / UAT rows.
- Identity / profile / role / tenant tables.
- Operational `check_reconciliation_alerts` / `glba_security_events`.
- The 5 bridge-denylisted credential tables.

## 3. Post-apply proof

| Check | Result |
|---|---|
| Identified Freedom Adjustment Supabase→AWS production delta resolved | PASS (except the intentionally skipped provider-account cache row) |
| 3 storage objects exist correctly in AWS | PASS — sizes match |
| Financial aggregates unchanged and correct | PASS — deposits / disbursements / CheckAlt / claim payments / intake amounts identical |
| No duplicate deposit / payment / check / provider records | PASS — inserts used existing PKs; second apply with original sentinels is refused |
| AWS-only UAT / test records remain intact | PASS — Condition One Commercial still has 37 AWS-only `check_intake_items` |
| Tenant memberships / roles unchanged | PASS — `tenant_users` 7, `user_roles` 10 |
| Today's production Cognito mappings unchanged | PASS — 11 `identity_accounts` rows; all 8 repaired production `cognito_sub` values unchanged |
| No unintended tenant modified | PASS — Condition One Commercial row counts unchanged |
| No Moov / CheckAlt API calls | PASS — application-state only |

Idempotency: a second apply using the original pre-sync sentinels is
**refused** (expected; AWS no longer matches pre-sync). Re-insert of the
same primary keys cannot duplicate checks, deposits, payments, endorsements,
webhook events, or financial records.

## 4. Post-reconciliation production AWS fingerprint / baseline

The webhook cutover must preserve this baseline. Do not overwrite it with
stale Supabase / staging Cognito subs or a full database re-copy.

- **Applied at:** `2026-09-14T11:10:52.225Z`
- **Database:** RDS `checksops` (same physical DB as
  `checksops-production-prep-api`)
- **Identity:** 11 `identity_accounts` rows; 8 production Cognito subs
  unchanged from the 10:07 UTC repair
- **Freedom Adjustment Moov payment account** `26c2dbb1…` →
  `60922058-7eca-4889-81dd-5720d7b9de96` (AWS readiness preserved)
- **Freedom Adjustment Moov recipient** `62a858ff…` →
  `ee8c608e-dc2d-45d3-95e9-3c992f3dfc5f` `ready`
- **Freedom Adjustment checks:** `7d62ea7c…` `endorsements_in_progress`
  $413.03; endorsement `3d1565b9…` `signed`; `623442f0…`
  `approved_for_deposit` $9984.11 with CheckAlt paths
- **19** `payment_webhook_events` + **11** `payment_event_log` rows now in
  AWS
- **Financial aggregates:** unchanged from the read-only report
- **Condition One Commercial UAT:** 37 AWS-only intake checks still present
- **Storage:** 3 objects listed in §1.1

Repaired production `cognito_sub` values (do not import stale
Supabase / staging subs):

See `aws/identity/PRODUCTION_COGNITO_IDENTITY_REPAIR_20260914.md` §4. Those
8 mappings remain the AWS identity baseline.

## 5. Still deferred (explicit STOP)

- Moov / CheckAlt webhook destination cutover
- CheckAlt AWS readiness
- Preventing routine SPA deploys from reverting AWS mode
- Final Cognito SPA deploy

`checksops.com` still serves the live Supabase-mode bundle.

## 6. Tooling cleanup

Temporary Lambda `checksops-cursor-recon-apply-temp` was deleted after
COMMIT. Temporary apply tooling lived only under `/tmp/recon_apply/` and
`/tmp/recon_apply_lambda/` and is not committed. The rehearsal Lambda
`checksops-staging-rehearsal-oneshot` was not modified
(`CodeSha256=Uuqs/fRkCulPrdKUj72FJTlHdTkfhVXc+mttZljUzwk=`).

## 7. Evidence

- `aws/db-copy/reconciliation-20260914/apply/preflight_delta.json`
- `aws/db-copy/reconciliation-20260914/apply/ops_manifest.json`
- `aws/db-copy/reconciliation-20260914/apply/storage_copy.json`
- `aws/db-copy/reconciliation-20260914/apply/apply_result.json`
- `aws/db-copy/reconciliation-20260914/apply/postverify.json`
- `aws/db-copy/reconciliation-20260914/apply/POST_RECONCILIATION_AWS_FINGERPRINT.json` — copy-pasteable webhook-cutover baseline
