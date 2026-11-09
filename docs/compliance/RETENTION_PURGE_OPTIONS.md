# Retention purge: automated on AWS, or recorded manual

**Owner:** the CEO (Qualified Individual), security@checksops.com
**Prepared:** 2026-11-09, from the repository on main `17419cbc6` and read-only AWS reads as
`user/claude-code` (14:02 UTC)
**Status:** options paper for an owner decision. It changes nothing in AWS, the database or the
application.
**Matrix row:** C1.2 "Confidential data disposed of on schedule" (**Gap**) in
`docs/compliance/SOC2_CONTROL_MATRIX.md`; evidence calendar row D-1; risk R6 in
`docs/compliance/RISK_REGISTER.md` ("decide between rebuilding the automated purge on AWS and a
recorded manual purge", owner date 2027-06-30).

## 1. The question and why it can wait, but not forever

`docs/DATA_RETENTION.md` keeps claim files, check images, ACH records and payee records for 7 years
after the triggering event, then disposes of them. On Supabase a nightly edge function did the
disposal. It was not carried over to AWS (`aws/providers/EDGE_FUNCTION_INVENTORY.md`, section D),
so today nothing purges. ChecksOps data starts in late 2025, so under the 7-year default no closed
claim reaches its `retention_purge_after` date before about 2032 (`DATA_RETENTION.md` §4).

Two things can make a purge due sooner, and either option below must cover them:
- **Tenant termination**: 30-day grace, then full export and purge (`DATA_RETENTION.md` §3). No
  purge code for this exists on AWS; the tenant lifecycle functions (SQL 118) deactivate tenants
  and delete empty ones, nothing more (`ops/production-sql-118-apply.md`).
- **A shorter per-tenant period**: `tenants.data_retention_years` (default 7; "minimum 7 unless
  local law allows shorter").

An auditor will test C1.2 in the observation period whether or not anything is due. What they need
is a designed control that would work, and a record that it was operated.

## 2. What existed before the move (Supabase)

`supabase/functions/glba-retention-purge/index.ts`, described as "runs nightly":

| Step | What the code does |
|---|---|
| Select | Up to 500 `claims` with `retention_purge_after <= now()` and `legal_hold` null or false |
| Dry run | `?dry_run=1` logs the candidate count and stops |
| Delete | Rows in `claim_files` for those claims (the only table in `tablesToDelete`) |
| Redact | Sets `policyholder_name`, `_email`, `_phone`, `_address`, `policy_number`, `ssn_last_four`, `notes` to null on the claims; keeps the rows and financial totals |
| Log | One `glba_security_events` row, `event_type` `retention_purge_run` (or `retention_purge_error`), severity `info`, metadata with the counts and the tenant ids touched |

The date it works from is set by the trigger `trg_set_claim_retention` →
`public.set_claim_retention_purge_after()` (`supabase/migrations/20260613110457_…sql`): when a claim
moves to `closed`, `settled`, `denied` or `archived`, `retention_purge_after = now() +
tenants.data_retention_years`. The trigger is in the schema inventory copied to AWS
(`aws/db-copy/analysis/public_triggers_by_category.md`, category data-integrity).

**What the old function did not do, read from its code and the generated schema types**
(`src/integrations/supabase/types.ts`):
- **No file deletion.** It deleted `claim_files` rows, not the stored objects. The policy's
  "and the matching S3 objects" (`DATA_RETENTION.md` §4 step 2) was never implemented.
- **Most tables in the policy were untouched.** `claim_photos`, `claim_communications_diary`,
  `claim_check_payments`, `check_intake_items` and `disbursement_splits` are in the policy, not in
  the code.
- **`claims.legal_hold` does not appear in any migration or in the generated types**, and the
  generated `claims` row lists no `notes` column. Against that schema the legal-hold filter and the
  redaction update would have failed (the function only logs a warning for the redaction).
  Whether it ever completed a real purge is **unknown**; nothing was due, so it may never have had
  to.
- How it was scheduled is **unknown**: no cron definition for it is in the repository.

So "rebuild the purge" is really "build it for the first time": the Supabase function is a sketch,
not a working design to port.

## 3. What exists on AWS today

| Piece | State | Source |
|---|---|---|
| Retention date | `claims.retention_purge_after` and its trigger are in the copied schema. **Not verified live** on `checksops-production`; a read-only inspect would confirm the trigger and how many claims have a date set | `aws/db-copy/analysis/triggers_classified.json` |
| Legal hold | No column. `DATA_RETENTION.md` §5 promises `claims.legal_hold`; it needs a migration | grep of `aws/workflows/sql/`, `supabase/migrations/`, `types.ts` |
| Purge SQL function | None. No file under `aws/workflows/sql/` (highest number today: 146) mentions retention or purge | `aws/workflows/sql/` |
| Purge Lambda job | None. `aws/functions/api/scheduled.mjs` accepts one scheduler job, `checkalt-poll-deposits` (`SCHEDULER_DIRECT_JOBS`) | `aws/functions/api/scheduled.mjs` |
| Scheduler pattern | One production stack, `aws/production/checkalt-status-reconcile-schedule.yaml`: EventBridge Scheduler invokes `checksops-production-prep-api` directly, a role that may only invoke that function, the job runs as a platform-owner `application_user_id` under row security, `State: DISABLED` pauses it | `ops/checkalt-status-reconcile-schedule.md` |
| Purge record | `glba_security_events` exists on AWS and is in the API's allowed tables | `aws/functions/api/allowed-tables.json` |
| S3 deletes in the API | `DeleteObject` / `DeleteObjects` without a `VersionId` (`storage-write.mjs`, `tenant-library.mjs`, `workflow-delete-check.mjs`). In a versioned bucket that adds a delete marker; earlier versions stay | code |

### Where a purged record's copies live (read 2026-11-09 14:02 UTC)

| Copy | Live state | What a purge has to do about it |
|---|---|---|
| Files bucket `checksops-production-privatefiles-806168576068` (`us-east-1`) | Versioning Enabled; lifecycle has only `AbortIncompleteMultipartUploads` (7 days), **no noncurrent-version expiration**; no Object Lock | A plain delete leaves every earlier version **for ever**. The purge must delete each version by `VersionId` (and the delete marker), or a lifecycle rule must expire noncurrent versions |
| Copy bucket `checksops-production-privatefiles-dr-806168576068` (`us-east-2`) | Replication rule `CopyToUsEast2` Enabled, **delete marker replication Disabled**; lifecycle only aborts incomplete uploads; no Object Lock; policy `DenyInsecureTransport` only | Deletes in `us-east-1` never reach it, by design (`ops/security/FILES_BUCKET_REPLICATION_2026_11.md`). **Every purged file stays here until it is deleted here, by version.** Nothing today has delete rights on this bucket except an administrator (the replication role can only write) |
| Compliance documents (`files/verification-docs/`) | Copies are SSE-KMS under the `us-east-2` key `c5863c6d-…` (`alias/checksops-production-compliance-documents-dr`), which nobody can decrypt until a recovery adds a statement | Deleting an S3 object version needs no KMS decrypt, so the key does not block a purge. Deleting the key is **not** a per-record purge: it would make every copy unreadable (phase 2 rollback note). These are Moov onboarding documents, tenant-level not claim-level; their retention class is **not named** in `DATA_RETENTION.md` §2 |
| RDS `checksops-production` automated backups (`us-east-1`) | 35 days, deletion protection on; **0 manual snapshots** | Purged rows remain in backups up to 35 days, then roll off (`DATA_RETENTION.md` §6). Nothing to do except: no manual snapshot without written approval |
| RDS replicated automated backups (`us-east-2`) | Status `replicating`, 35 days, earliest restore time 2026-11-06 19:02 UTC; **0 manual snapshots** in `us-east-2`; AWS Backup: 0 plans in either region | Same 35-day roll-off. `DATA_RETENTION.md` §6 names only the `us-east-1` window; it should name both |
| A restored database | The restore test (`ops/security/RESTORE_TEST_RUNBOOK.md`, row B-1) restores to a new instance and deletes it | A restore to a point before a purge brings the purged rows back. The restore procedure must re-run the purge (or confirm none ran in the window) before the restored copy goes live |
| Application logs (CloudWatch) | 90 days (`ops/security/LOG_RETENTION_AND_DR_2026_11.md`, applied 2026-11-06) | Personal data that reached a log expires in 90 days. Nothing to do |
| CloudTrail and AWS Config | 7 years in the security-logs bucket; the trail is `checksops-production-mgmt-events` (management events) | Whether S3 data events (object keys) are logged is **not recorded** in the repository. Object keys contain tenant ids, not names. Kept 7 years as audit logs by policy |
| Application audit tables (`audit_logs`, `pii_reveal_logs`, `glba_security_events`, …) | 7 years by policy | The purge record itself must hold counts and ids only, no NPI (the Supabase function logged counts and tenant ids) |

## 4. Option A: automated purge on AWS

### What would be built

1. **A new numbered SQL migration** (the next free number when it starts) taken through the
   guarded path in `CLAUDE.md`: staging read-live and apply, read-only production inspect, pin PR
   with `execute: true`, production apply through `production-sql-one-shot.mjs` with the owner's
   exact words, record PR with `execute: false`. It would add:
   - `claims.legal_hold boolean not null default false`, and who may set it (owner only), with a
     log row on change (`DATA_RETENTION.md` §5);
   - an owner-only `SECURITY DEFINER` function that, for a batch of due claims not on hold,
     deletes or nulls the personal fields in every table `DATA_RETENTION.md` §4 names, keeps the
     de-identified financial totals, returns the S3 keys to delete, and writes the
     `glba_security_events` row with counts;
   - the same for check images, ACH, 1099 payee and micro-deposit records if the purge is to cover
     the whole §2 schedule, not only claims. Their triggering dates ("after deposit clears", "after
     tax year filed", "after account closed") have **no column today**; each needs one, or the
     purge covers claims only and the rest stays manual.
   - Its own per-migration apply tool under `scripts/deployment-guard/` and a test on PostgreSQL 16
     (every row of the one-shot table in `ops/production-sql-one-shot.md` has one).
2. **A Lambda job** in `aws/functions/api/` added to `SCHEDULER_DIRECT_JOBS`, following
   `checkalt-poll-deposits`: runs as a platform-owner actor, calls the SQL function, then deletes
   every **version** of each returned key in the `us-east-1` bucket. Each member goes through
   `guarded-production-lambda-overlay.yml` with its own staging acceptance and
   `DEPLOY <member> TO PRODUCTION`.
3. **Delete rights it does not have today.** Whether the production API role holds
   `s3:DeleteObjectVersion` is **not recorded**; the bucket policy allows it "read, write and
   delete". For `us-east-2`, a role must be given `s3:DeleteObjectVersion` on the copy bucket. That
   is the one right the replication design deliberately keeps from everything automated ("a
   deletion or a ransomware wipe in `us-east-1` cannot remove the `us-east-2` copy"). Giving it to
   an always-on Lambda weakens R7. Alternatives: a separate role used only by the purge job and
   scoped to the claim prefixes (keys are `files/{bucket}/{path}`, for example `files/claim-files/`,
   per `aws/functions/api/storage-paths.mjs`); or leave `us-east-2` to a manual step.
4. **A scheduler stack** like `aws/production/checkalt-status-reconcile-schedule.yaml`, created by
   an owner-approved operator, `State: DISABLED` until the first supervised run; monthly or
   nightly.
5. **A dry-run mode** (as in the Supabase function) and a cap per run.
6. **Monitoring**: an alarm on a `retention_purge_error` event or a missed run, to SNS
   `checksops-production-security-alerts`.

### Effort and risks (estimate, not measured)

- **Effort:** one SQL migration (about five PRs on the guarded path, plus the apply tool and the
  PG test), three or four Lambda members (each its own staging and production run), one IAM change
  and one scheduler stack (each an owner-approved change). Judging by the SQL and Lambda changes
  recorded in `ops/`, several weeks of elapsed time and a dozen or more owner approvals.
- **Risks:** an irreversible delete of the wrong rows or files by a bug, running unattended (the
  backups cover 35 days, the deleted S3 versions are gone); a standing delete right on the
  `us-east-2` copy (R7); more code and permissions to review every year; built six years before
  anything is due, against a schema that will keep changing, so it would need retesting before
  2032 anyway.
- **Benefit:** the control runs by itself, the evidence is the event log, and tenant terminations
  or shorter periods are handled on time without anyone remembering.

## 5. Option B: recorded manual purge (yearly, owner-run)

### Procedure

Once a year (and within 30 days of a tenant termination's grace period ending):

1. **Query (read-only).** Count, per tenant, the claims with `retention_purge_after < now()`, and
   the other §2 record classes past their period. Until about 2032 the expected answer is 0. How
   the query runs is to be settled: the existing read-only production path is the one-shot's
   `--phase inspect`, which is built per migration; whether it, or another approved read-only
   path, can run a standing count query is **unknown** and is the first thing to build or confirm.
   No psql by hand (`AGENTS.md`).
2. **Review.** The owner reviews the list (ids and counts only), removes anything on legal hold or
   under a dispute, and approves in writing, naming the tenant or the claims
   (`DATA_RETENTION.md` §4).
3. **Delete through an approved path.** For the database: a numbered SQL change through the guarded
   staging and production path, as `DATA_RETENTION.md` §4 already requires for every purge. For the
   files: the owner deletes every version of each key in **both** buckets, in CloudShell as
   `michael-admin`, from a key list the database step produced, as the replication runbook does for
   its own changes. The `us-east-2` deletes are a step of their own, never skipped.
4. **Record.** A `glba_security_events` row (severity `info`, counts as metadata) and a file
   `docs/compliance/evidence/YYYY-MM-DD-D-1-retention-purge.md` with: date, who, the query and its
   count, the approval, rows changed per table, S3 versions deleted per bucket, CloudTrail event ids
   for the bucket deletes, and the 5-claim sample of `DATA_RETENTION.md` §7. A year with 0 due is
   recorded too ("query returned 0; nothing purged").

### What it needs before the first record

- The read-only count query and its approved path (step 1).
- `claims.legal_hold`, or a written decision that holds are kept in a list outside the database
  until the column exists.
- A procedure file (for example `ops/security/RETENTION_PURGE_RUNBOOK.md`) with the commands, the
  stop conditions and the record template.
- `DATA_RETENTION.md` §4 and §7 and the evidence calendar row D-1 changed from "after the AWS purge
  exists" to "yearly".

### Effort, risks and the audit view

- **Effort:** one runbook, one read-only query path, and a yearly run of about an hour while the
  count is 0. A real purge (2032 or a termination) costs a SQL change through the guarded path and
  a supervised bucket delete.
- **Risks:** it depends on a person remembering (mitigated by the calendar row and the annual QI
  report, R-4); a key-person dependency (R9) if only the owner can run it; mistakes in a manual
  delete (mitigated by the key list coming from the database step and the review).
- **Audit view:** a documented, owner-approved manual control with a dated record of each
  operation is an accepted design for SOC 2. The auditor will sample the yearly records in the
  observation period, so the "0 due" years must be recorded, not skipped.

## 6. What both options must handle

1. **The `us-east-2` file copies.** Deletes are not replicated, and neither bucket expires old
   versions. Without an explicit delete of every version in both buckets, a purge removes nothing
   from storage. Whoever deletes in `us-east-2` must be an identity the owner approves for it.
2. **The compliance-document key.** No KMS action is needed to delete a version; never use key
   deletion as a purge. Decide the retention class of Moov onboarding documents (not in §2 today).
3. **Database backups.** 35 days in `us-east-1` and the replicated 35 days in `us-east-2`; no
   manual snapshots, no AWS Backup plans (read 2026-11-09). Name both windows in
   `DATA_RETENTION.md` §6, and add "re-apply purges after a restore" to the restore runbook.
4. **Logs.** CloudWatch 90 days; audit logs 7 years. The purge record holds counts and ids only.
5. **Legal hold.** The policy names a column that does not exist; either option needs it, or a
   written alternative.
6. **Tables beyond claims.** The §2 classes other than claim files have no purge date column.

## 7. Recommendation

**Option B, a recorded manual purge run yearly, for now; revisit option A at the annual policy
review once volume or the first due date (about 2032) makes a yearly manual run unreasonable.**

Reasons, from the facts above: nothing is due for about six years; the Supabase purge never
deleted files and could not have honored legal holds, so option A is new work, not a port; the
automated design needs a standing delete right on the `us-east-2` copy that the replication design
deliberately withholds; and an auditor accepts a documented manual control with dated records. The
gaps in §6 (legal hold, the second region, backup wording, non-claim record classes) have to be
closed under either option, and the manual procedure closes them with the least new permission.

**Evidence an auditor would want either way:**
- The policy (`DATA_RETENTION.md`) and the procedure or code, matching each other.
- For each period: the dated D-1 record (query result, approval, counts per table and per bucket,
  CloudTrail ids), including the zero years.
- The `glba_security_events` row for each run.
- The quarterly or yearly sample of purged claims (`DATA_RETENTION.md` §7), once any exist.
- The legal-hold list and its changes.
- The backup windows read from AWS, showing purged data leaves backups within 35 days in both
  regions.

**Follow-up PRs, each separate, none part of this one:** the purge runbook; the `DATA_RETENTION.md`
and calendar wording; the legal-hold migration (guarded path); the read-only count query path.

## 8. Decision

- [ ] **B**: recorded manual purge, yearly, as in §5 (recommended)
- [ ] **A**: build the automated purge on AWS, as in §4
- [ ] Other: ________________________________________________

Decided by: ______________________ (CEO, Qualified Individual)  Date: __________

## Not covered here

- No change to AWS, the database, the application, the policy text or the evidence calendar.
- No purge was run and no data was read: the AWS reads were configuration only (bucket versioning,
  lifecycle, replication and Object Lock; RDS backup settings and snapshot counts; AWS Backup plan
  counts). The EventBridge Scheduler listing was refused to `claude-code` (`AccessDenied`), so the
  live schedules were not read.
- Not verified live: the retention trigger and the number of claims with a purge date in
  production; the production API role's S3 version-delete rights; whether CloudTrail records S3
  data events.
