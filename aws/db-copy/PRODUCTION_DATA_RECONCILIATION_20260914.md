# Production data reconciliation — Supabase (live) vs AWS RDS `checksops` — 2026-09-14

**Mode: READ-ONLY.** No rows were inserted, updated, or deleted on either side. No
storage objects were copied, moved, or deleted. No webhook destinations,
provider configuration, or DNS were changed. No migrations were run. The SPA
was not deployed. This is strictly an investigation and report, continuing
from the successful production Cognito identity repair documented in
`aws/identity/PRODUCTION_COGNITO_IDENTITY_REPAIR_20260914.md`.

## 0. Tooling used (all pre-existing, read-only, or newly-created and read-only)

| Tool | Side | Mode | New/existing |
|---|---|---|---|
| `supabase/functions/aws-staging-db-bridge` | Supabase | `health`/`tables`/`schema`/`counts`/`rows` | Existing (PR #127), still deployed, still fail-closed and read-only |
| `supabase/functions/aws-staging-storage-bridge` | Supabase | `health`/`inventory` | Existing (PR #92/#127), still deployed, still sign-only (no `sign` calls were made — no content was downloaded) |
| `checksops-cursor-recon-readonly-temp` (Lambda) | AWS RDS `checksops` | `counts`/`schema`/`keys`/`rows`/`financial` | **New, temporary**, created for this task. Every query runs inside `BEGIN; SET TRANSACTION READ ONLY; … ROLLBACK;`. Contains zero `INSERT`/`UPDATE`/`DELETE` statements. **Deleted at the end of this task** (see §8). |

Both bridges were re-verified live and healthy before use:

```json
{"ok":true,"mode":"read_only","writes":false,"deletes":false,"rpc":false,"rawSql":false}
```

The AWS-side Lambda reused the same execution role/VPC/subnets as
`checksops-staging-rehearsal-oneshot` (the same pattern used for the Cognito
identity repair), and connected as `checksops_admin` to the `checksops`
database — the same physical database that is both the AWS migration target
and the database backing `checksops-production-prep-api`.

## 1. Reconciliation baseline timestamp

**`2026-09-01T20:36:44.000Z`** — the cutoff of the S3 custom-format dump
`Migration/checksops_260901(1).backup` (49,100,401 bytes), documented in
`aws/db-copy/lib/db-bridge.mjs` (`BASELINE_CUTOFF`) and
`aws/db-copy/FIRST_COPY_STATUS.md`. That dump was restored into the isolated
AWS RDS database `checksops` on **2026-09-02** (PR #71), and that restore is
the **only full copy that has ever been applied to the live `checksops`
database**. 166 tables were restored; RLS was not applied; 47 FKs to
`auth.users` were skipped; Supabase Auth users were not loaded.

A second exercise on **2026-09-05** (PR #127) used the DB bridge to
*classify* a Sept‑1→live delta (632 inserted / 66 updated / 3 deleted) and
*apply* it — but only into an **isolated rehearsal clone**,
`checksops_rehearsal_20260905` (`CREATE DATABASE … TEMPLATE checksops`), never
into the live `checksops` database. The storage COPY bridge did apply its
delta directly (77 new objects) on 2026-09-05, because storage COPY is
additive/idempotent and non-destructive by design.

**Conclusion:** the live AWS `checksops` database's pre-existing (Sept‑1-era)
rows have received **zero** database synchronization since 2026-09-02.
Everything found below dated after 2026-09-02 on the AWS side was written
directly by AWS-side application/testing traffic hitting the AWS backend
(`checksops-production-prep-api` or the temporary validation Lambdas used in
prior tasks), not by any migration/bridge sync. Everything found on the
Supabase side after 2026-09-01 is organic production traffic through the
still-live Supabase-mode SPA, Edge Functions, and provider webhooks.

## 2. Scope: tables inventoried

167 base tables in `public` (from `aws/db-copy/sql/reconciliation_counts.sql`,
the same list used for the original PR #71/#127 reconciliation). Supabase's
`tables` bridge action returned 181 names; the 14-name difference is fully
accounted for:

- **4 AWS-only overlay tables**, intentionally never in the Sept‑1 dump or in
  Supabase (`identity_accounts`, `aws_provider_sandbox_operations`,
  `_checksops_restore_complete`, `homeowner_upload_otp_sessions`).
- **1 PostGIS system table** (`spatial_ref_sys`, 8,500 fixed EPSG rows) —
  denylisted by the bridge, immutable reference data, not a reconciliation
  concern.
- **5 credential/token-adjacent tables denylisted by the bridge itself**
  (`email_unsubscribe_tokens`, `homeowner_bank_link_tokens`,
  `homeowner_ledger_tokens`, `payment_idempotency_keys`,
  `tenant_openai_credentials`) — see §7 (BLOCKED/UNKNOWN) below.
- **19 Supabase-only names are views**, not base tables (`tenants_public`,
  `tenant_safe`, `claim_money_snapshot`, `deposit_*_dashboard/summary/kpis`,
  `stale_endorsements`, `geography_columns`, `geometry_columns`, etc.) —
  derived from base tables already compared; not separately reconciled.

Full raw counts for both sides: `aws/db-copy/reconciliation-20260914/all_table_counts.json`.

## 3. Row-count comparison, all 167 tables

| | Count |
|---|---:|
| Tables with **identical** row count on both sides | **123** |
| Tables with **different** row count | **38** |
| AWS-only overlay tables (expected, by design) | 4 |
| Denylisted by bridge (credential-adjacent; count unknown) | 5 |

Full per-table numbers: `aws/db-copy/reconciliation-20260914/count_comparison.json`.
**Row-count equality was not treated as parity** — see §4 for key/timestamp-level
verification of the 123 "matching" tables that matter (identity, tenants,
Moov/CheckAlt config, billing, provider accounts, disbursements, deposits, etc. — all confirmed
identical at the key/`updated_at` level, not just by count).

Of the 38 differing tables, key-level diffing (Supabase vs AWS `id` sets, with
`updated_at`/`created_at` compared as parsed timestamps to avoid a
millisecond-vs-microsecond string-format false positive between
`node-postgres` and PostgREST) resolves every difference into one of four
buckets:

- **AWS-only rows** (`awsOnly`) — exist in AWS, not in Supabase.
- **Supabase-only rows** (`sbOnly`) — exist in Supabase, not in AWS. **These are candidate missed production writes.**
- **AWS-newer** — same row id both sides, AWS's `updated_at` is later.
- **Supabase-newer** — same row id both sides, Supabase's `updated_at` is later. **These are candidate missed production updates.**

Full per-table breakdown (90 tables: all 38 differing + the explicitly named
domains that matched on count) with sampled ids for every bucket:
`aws/db-copy/reconciliation-20260914/table_key_level_delta.json`.

## 4. Classification of every material discrepancy

### 4.1 AWS-side testing/validation writes (safe; do not treat Supabase as authoritative-by-deletion for these; do not overwrite them)

The large majority of the 38 count differences are AWS-only rows created
directly against the live AWS backend by prior validation work, almost all
under tenant `4f172140-f57a-4744-8050-95f4f07b13b4` ("**Condition One
Commercial**" / "C1C", the designated AWS UAT tenant referenced throughout the
provider-validation branches) or tied to explicit test markers:

| Table | AWS | Supabase | AWS-only | Evidence |
|---|---:|---:|---:|---|
| `check_audit_log` | 2,155 | 2,009 | 148 | `event_type` values `aws_workflow_created`, `aws_workflow_transition`, `endorsement_completed`, all tenant `4f172140` (C1C), dated 2026‑09‑11→13 |
| `tenant_usage_logs` | 101 | 38 | 63 | `event_type: ocr_intake`, tenant `4f172140`, 2026‑09‑11→13 |
| `email_send_log` | 204 | 146 | 64/58 net | `status: "sunk"` (intentional non-delivery, sandbox safety behavior), tenant `4f172140`, recipient `mc***@freedomadj.com` and `sink-endorsement@example.invalid` |
| `check_intake_items` | 231 | 194 | 37 | tenant `4f172140`; financial aggregate delta of `check_intake_amount` (+$11,131.05, see §4.4) is fully explained by these 37 rows |
| `check_endorsements` | 560 | 533 | 27 | tied to the same 37 AWS-only `check_intake_items` |
| `check_payees` | 551 | 525 | 26 | tenant `4f172140`, 2026‑09‑12 |
| `claim_folders` | 1,295 | 1,281 | 14 | folder names `Carrier Documents`/`Invoicing`/`AI Assistant Reports`/`Certificate of Completion`, 2026‑09‑11 |
| `homeowner_ledger_events` | 730 | 717 | 14 | tenant `4f172140` |
| `check_billing_events` | 138 | 126 | 12 | `event_type: mortgage_handling`, `status: reported`; **10 of 12 under tenant `4f172140`, 2 under the real tenant `2eff5f1a` (see §4.3 caveat)** |
| `homeowner_ledger_check_uploads` | 14 | 4 | 10 | `status: pending_review`, tenant `4f172140`, 2026‑09‑11→13 |
| `check_message_reads` | 29 | 20 | 9 | composite PK (`user_id`,`check_id`), no timestamps; consistent with repeated T0/tester smoke-test runs re-reading the same check threads |
| `financial_stepup_log` | 5 | 2 | 3 | tenant `2eff5f1a` (see §4.3 caveat — real tenant touched by a step‑up/MFA validation test) |
| `endorsement_requests` | 403 | 400 | 3 | 2026‑09‑13→14 |
| `homeowner_intro_requests` | 6 | 3 | 3 | 2026‑09‑13 |
| `signature_requests` / `signature_signers` | 9 / 9 | 6 / 6 | 3 / 3 | 2026‑09‑11 |
| `loss_draft_audit_log` | 105 | 101 | 4 | |
| `loss_draft_tracking` | 42 | 36 | 6 | |
| `mortgage_handling_requests` | 4 | 2 | 2 | tenant `4f172140` |
| `claim_cases`/`check_cases` | 144 | 142 | 2 | tenant `4f172140`, `status: active`, 2026‑09‑11 |
| `claims` / `claim_operational_state` | 185/185 | 183/183 | 2 / 2 | see §4.3 — 1 of the 2 `claims` rows is AWS-newer on an id that also exists in Supabase (test mutation, not a new claim) |
| `tenant_documents`, `claim_settlements`, `claim_project_plans`, `homeowner_check_uploads` | — | — | 1 each | all dated 2026‑09‑11→13, tenant `4f172140` or no tenant column |
| `profiles` | 9 | 8 | 1 | **new AWS-only application user** `ch***@gmail.com` / "ChecksOps Administrator", created 2026‑09‑10 directly in AWS — not a Cognito-sub drift case (see §5), a genuinely new row that only exists in AWS |
| `checkalt_config` | 1 | 1 | 0 (aws-newer) | tenant-wide config row touched by AWS testing, same id both sides |
| `tenants` | 6 | 6 | 0 (2 aws-newer) | AWS testing touched `updated_at` on tenants `4f172140` (C1C) and `2eff5f1a` (Freedom Adjustment) only; the other 4 tenants are untouched on both sides since Aug 28/31 |

**Storage:** 45 objects exist only on the AWS S3 side (under
`files/{bucket}/{path}` in `checksops-staging-privatefilesbucket-erzqsolpucjp`).
Every one is explainable as a test artifact: 15 have explicit test markers in
the path (`aws-t3-test`, `aws-t5-test-front.jpg`, `aws-step2`,
`synthetic-textract-live-verify`, `synthetic-uat`, `pr129-staging-validation`);
the remaining 30 are tiny placeholder images (126–241 bytes — far too small to
be a real check/homeowner photo) or tiny placeholder PDFs (1.1–1.3 KB — far
too small to be a real signed document) under the tester tenant
(`7dbb3009-…`), the C1C UAT tenant (`4f172140-…`), or two orphaned check-id
folders (`69254974-…`, `aaca0a89-…`) holding realistic-sized `*-void.jpg`
images that do not correspond to any Supabase check and are consistent with
an AWS-side micro-deposit/void-check-verification test. None of the 45 share
a path with any real Supabase object (0 path or size collisions), so no
future Supabase→AWS storage COPY would ever need to overwrite them — see
§6. Full list: `aws/db-copy/reconciliation-20260914/storage_delta.json`.

### 4.2 Genuine production writes that reached Supabase but not AWS (the primary finding)

**Tenant `2eff5f1a-929d-4ce3-9a8b-cd96b98df42a` — "Freedom Adjustment"** — a
named, real production tenant (not a test/UAT tenant name) — has ongoing
production activity in the still-live Supabase-mode SPA that has **never
reached AWS**, because AWS has received zero sync since 2026‑09‑02:

**A. A complete real check-endorsement transaction, 2026‑09‑10 16:31 UTC** — every
row is Supabase-only or Supabase-newer, and all timestamps line up to the
second:

| Table | Row | Supabase state | AWS state |
|---|---|---|---|
| `check_intake_items` | id `7d62ea7c…` | `status: endorsements_in_progress`, amount **$413.03**, `updated_at` 2026‑09‑10 16:31 | stuck at `updated_at` 2026‑07‑28 (stale) |
| `check_endorsements` | id `3d1565b9…` | `status: signed`, `updated_at` 2026‑09‑10 16:31:42 | **row does not exist in AWS** |
| `check_endorsement_events` | id `e506cafa…` | `event_type: endorsement_signed`, created 2026‑09‑10 16:31:42 | **does not exist in AWS** |
| `endorsement_audit_log` | id `37110f14…` | created 2026‑09‑10 16:31:42 | **does not exist in AWS** |
| `homeowner_ledger_events` | id `60bdd1e0…` | `event_type: endorsement_signed`, created 2026‑09‑10 16:31:41 | **does not exist in AWS** |
| `audit_logs` | ids `d8588653…`/`3c36179a…`/`3783624d…` | `create`/`update` actions, 2026‑09‑10 18:14 | **do not exist in AWS** |
| Storage | `checks/7dbb3009…/unclaimed/…back_IMG_0978_cropped_endorsed_1789057905238.svg` | endorsement signature overlay, 2026‑09‑10 16:31:45 | **object does not exist in AWS S3** |

**B. A real check moved to CheckAlt deposit, 2026‑09‑10 18:14 UTC**:

| Table | Row | Supabase state | AWS state |
|---|---|---|---|
| `check_intake_items` | id `623442f0…` | `status: approved_for_deposit`, amount **$9,984.11**, `updated_at` 2026‑09‑10 18:14:20 | stuck at `updated_at` 2026‑09‑04 (stale) |
| Storage | `…front_IMG_1183_cropped.checkalt.jpg`, `…endorsed_deposit_18vd.checkalt.jpg` | checkalt-processed images, 2026‑09‑10 18:14 | **objects do not exist in AWS S3** |

**C. Ongoing real Moov payment-provider onboarding and webhook activity, 2026‑08‑31 → 2026‑09‑14 (today)**:

| Table | Supabase count for tenant `2eff5f1a` | AWS |
|---|---:|---|
| `external_payment_recipients` | 2 recipient rows for "Michael Carletta" (individual), `onboarding_status` progressed `awaiting_bank`→`ready`, latest `updated_at` **2026‑09‑13 18:25** | AWS has the same 2 row ids but with stale `onboarding_status`/`updated_at` |
| `payment_provider_accounts` | 1 row, `updated_at` **2026‑09‑14 01:27** (today) | AWS has the same row id, stale |
| `stakeholder_accounts` | 3 rows (homeowner/subcontractor/contractor), latest `updated_at` **2026‑09‑14 01:27** | AWS has the same 3 row ids, stale |
| `stakeholder_account_verification_log` | 2 rows, `event_type: resent`, 2026‑09‑10 16:40/17:37 | **do not exist in AWS** |
| `payment_webhook_events` | **19 real live Moov webhook callbacks**: `bankAccount.updated`, `paymentMethod.enabled`, `balance.updated`, `account.updated`, `walletTransaction.updated`, `capability.updated`/`requested`, `wallet.created` — dated 2026‑09‑12 and 2026‑09‑13 | **none of the 19 exist in AWS** |
| `payment_event_log` | 11 matching application-side event-log entries for the same Moov callbacks | **none exist in AWS** |
| `tenant_email_settings` | 1 row, `updated_at` **2026‑09‑14 03:15** | AWS has the row, stale |
| `email_send_log` | 4 real transactional emails (`status: sent`/`pending`) tied to the endorsement/verification activity above, 2026‑09‑10, plus 2 more dated **2026‑09‑14 01:24** | **do not exist in AWS** |

**This means the Moov webhook destination is still configured to point at
Supabase, and Moov is actively delivering real account/wallet/capability
callbacks there as of today.** This corroborates, with hard evidence, why the
user separately flagged "do not change webhook destinations yet" as a
distinct, not-yet-completed phase of this migration — a webhook cutover
before this reconciliation would have been premature.

### 4.3 Caveat: AWS-side testing has already written into the real "Freedom Adjustment" tenant

Not all AWS-only/AWS-newer activity is confined to the dedicated UAT tenant.
Specific, narrowly-scoped exceptions found:

- `check_intake_items` ids `64fca2df…` and `c7ea8b6a…` (tenant `2eff5f1a`,
  amounts $1,492.47 and $119.47) show **AWS `updated_at` newer than
  Supabase** (2026‑09‑11, vs. Supabase's real last-touch of 2026‑09‑03). AWS
  testing mutated the `status`/`updated_at` of these two real rows after the
  Sept‑1 copy; Supabase's true current state for these two checks is still
  `needs_review` as of Sept 3 and has not changed since.
- `check_billing_events`: 2 of the 12 AWS-only rows (`482ed9b0…`,
  `68417337…`) are tagged tenant `2eff5f1a` and dated 2026‑09‑11.
- `financial_stepup_log`: all 3 AWS-only rows are tagged tenant `2eff5f1a`,
  dated 2026‑09‑09→11 (a step‑up/MFA challenge test exercised against the
  real tenant's context rather than the C1C UAT tenant).
- `tenants`: the real tenant's own row (`2eff5f1a`) has an AWS-side
  `updated_at` newer than Supabase's.

**None of this is destructive** — no real row was deleted, no real financial
amount changed, no real recipient/account data was corrupted, and the
financial aggregate cross-check in §4.4 confirms the dollar-accurate tables
(`deposit_items`, `deposit_batches`, `disbursement_splits`,
`disbursement_batches`, `checkalt_deposits`, `claim_payments`) are in **exact**
agreement. But it does mean AWS's copy of a handful of real "Freedom
Adjustment" rows has diverged from Supabase's true current state in a way
that is **not** attributable to Supabase being behind — the AWS side is the
one that drifted for these specific ids. Any reconciliation plan must treat
Supabase as authoritative for these ids and not re-propagate AWS's test-driven
`status`/`updated_at` values.

### 4.4 Financial aggregate cross-check (independent of the key-level diff)

Using the same 15 metrics as `aws/db-copy/sql/reconciliation_financial.sql`,
computed live on both sides:

| Metric | AWS | Supabase | Delta | Explained by |
|---|---:|---:|---:|---|
| `check_intake_amount` | $1,428,955.65 | $1,417,824.60 | **+$11,131.05** | the 37 AWS-only `check_intake_items` rows (C1C UAT, §4.1) |
| `endorsed_check_intake_amount` | $4,200,710.24 | $4,195,489.64 | **+$5,220.60** | the 27 AWS-only `check_endorsements` rows on the same UAT checks |
| `homeowner_ledger_amount` | $3,169,779.99 | $3,154,787.52 | **+$14,992.47** | the 14 AWS-only `homeowner_ledger_events` rows (C1C UAT) |
| `deposit_items_amount` | $1,037,630.29 | $1,037,630.29 | **$0.00** | exact match |
| `deposit_batches_total_amount` | $1,038,410.29 | $1,038,410.29 | **$0.00** | exact match |
| `checkalt_deposits_amount` | $453,990.48 | $453,990.48 | **$0.00** | exact match |
| `disbursement_splits_amount` | $880,702.79 | $880,702.79 | **$0.00** | exact match |
| `disbursement_batches_check_amount` | $888,258.73 | $888,258.73 | **$0.00** | exact match |
| `claim_payments_amount` | $114,621.50 | $114,621.50 | **$0.00** | exact match |
| `check_intake_pa_fee_amount`, `disbursement_batches_amount_reserved_cents`, `claim_check_payments_*`, `payment_transfers_amount_cents`, `payment_wallet_ledger_amount_cents` | — | — | **$0.00** | exact match (all zero or equal on both sides) |

Raw values: `aws/db-copy/reconciliation-20260914/{aws,supabase}_financial_aggregates.json`.

**No real financial amount is missing.** The only three non-zero deltas are
fully and exactly explained by AWS-only test rows already identified in §4.1
— they are additive (AWS has extra synthetic amounts on top), not a shortfall
of real money anywhere. The core money-movement domains that a check-cashing
platform must get right for a cutover — deposits, disbursements, CheckAlt,
claim payments — are in **exact** parity.

### 4.5 Identity / application users — Cognito baseline preserved

Per the explicit instruction to preserve today's repaired
`identity_accounts.cognito_sub` values as the AWS baseline:

- **`identity_accounts` was intentionally excluded from this comparison.**
  It is an AWS-only overlay table (`STAGING_ONLY_TABLES` in
  `aws/db-copy/lib/db-bridge.mjs`) that does not exist in Supabase at all —
  Supabase has no concept of a Cognito `sub`. There is nothing in Supabase
  that could be "more authoritative" for this column, and this reconciliation
  proposes **no** change to `identity_accounts` or to any `cognito_sub` value.
  Today's repair (`aws/identity/PRODUCTION_COGNITO_IDENTITY_REPAIR_20260914.md`)
  remains untouched and is not implicated by anything found here.
- `tenant_users` (7 rows) and `user_roles` (10 rows) — **byte-for-byte
  identical**, same ids, same `updated_at`, zero drift either direction.
- `profiles` — 8 Supabase / 9 AWS. The 1 AWS-only row is the new
  `ch***@gmail.com` test admin identity from §4.1, not a
  drifted/duplicated real user. All 8 real Supabase profiles exist in AWS
  with identical content.
- **Conclusion: no tenant or role drift, and no risk to the Cognito identity
  repair from this reconciliation.**

### 4.6 Other Supabase-only findings, not classified as either "production drift" or "test noise"

- `check_reconciliation_alerts`: 7 Supabase-only rows, all
  `alert_type: dashboard_count_mismatch`, `severity: critical`,
  `resolved: false`, one per day at 04:00 UTC from 2026‑09‑07 through
  2026‑09‑14 (today). This is Supabase's **own internal** application-level
  data-quality monitor (see `aws/functions/api/check-reconciliation.mjs` /
  `supabase/functions/check-reconciliation/index.ts`) firing daily and
  currently unresolved in production. It is unrelated to the AWS migration
  (it would fire even if AWS did not exist) but is a **pre-existing, currently
  unresolved production alert** worth the team's attention independent of this
  task. Not remediated here (read-only).
- `glba_security_events`: 7 Supabase-only rows, all `event_type:
  retention_purge_error`, one per day at 03:15 UTC from 2026‑09‑07 through
  2026‑09‑14 (today). A scheduled (likely `pg_cron`) data-retention purge job
  is failing daily in Supabase. Same characterization as above — a
  pre-existing Supabase-only operational issue, not an artifact of the AWS
  migration, and not remediated here.

## 5. Storage delta summary

| | Supabase (live) | AWS S3 (`files/` prefix) |
|---|---:|---:|
| Objects (8 app buckets with any content) | 1,414 | 1,456 |
| Bytes | 2,567,229,125 | 2,566,284,372 |
| Matched (identical key + size) | **1,411** | |
| Size mismatches on matched keys | **0** | |
| Supabase-only (missing from AWS) | **3** (§4.2‑A/B above) | |
| AWS-only (test artifacts, §4.1) | **45** | |

The 1,411 matched objects are exactly the count that was already reconciled
on 2026‑09‑05 (PR #127, `aws/db-copy/rehearsal/STORAGE_COPY_RECONCILE.md`),
confirming no bit-rot or accidental mutation since then. The delta since
then is entirely the 3 new real objects from the Sept‑10 Freedom Adjustment
transaction (missing from AWS) plus 45 new AWS-side test objects (present
only in AWS, as expected from ongoing validation work). Full detail:
`aws/db-copy/reconciliation-20260914/storage_delta.json`.

## 6. Do the migration bridges auto-sync, or are they one-off utilities?

**They are on-demand, manually-invoked, read-only/sign-only utilities. There
is no automatic or scheduled synchronization in either direction.**

Evidence:
- Both Edge Functions (`aws-staging-db-bridge`, `aws-staging-storage-bridge`)
  are plain `Deno.serve` HTTP handlers — no internal timers, no
  self-invocation, no `cron.schedule` calls anywhere in their source.
- No AWS EventBridge rule, EventBridge Scheduler schedule, or Lambda event
  source mapping references `checksops-production-prep-api`,
  `checksops-staging-rehearsal-oneshot`, or any bridge-calling Lambda
  (`aws lambda list-event-source-mappings` returned empty; no
  `Schedule`/`cron(`/`rate(` resources in any AWS SAM template reference the
  migration tooling).
- No GitHub Actions workflow in this repository runs on a schedule and calls
  either bridge.
- The only Postgres-side scheduled jobs (`pg_cron`) found in
  `supabase/migrations/` are unrelated application jobs (email queue
  processing, CheckAlt status polling, domain-recheck) — none of them call
  either migration bridge.
- Documented usage confirms this: the Sept‑2 full restore was a one-time,
  manually-triggered `pg_dump`/`pg_restore`. The Sept‑5 exercise was a
  manually-triggered rehearsal that explicitly wrote only to an isolated
  clone database. Today's reconciliation is the first time anyone has
  queried the live bridge again since Sept 5.

**Both bridges remain deployed in Supabase** (not yet torn down, matching the
"remove this function once AWS database reconciliation is confirmed" comment
in their own source) and both are still fail-closed on their migration token.
That is a live decision for the team, not something changed by this task.

## 7. BLOCKED/UNKNOWN — five tables the read-only bridge cannot see by design

`email_unsubscribe_tokens`, `homeowner_bank_link_tokens`,
`homeowner_ledger_tokens`, `payment_idempotency_keys`, and
`tenant_openai_credentials` are on the bridge's own hard-coded denylist
(`TABLE_DENYLIST` in `supabase/functions/aws-staging-db-bridge/index.ts`) —
by design, because they hold bearer tokens, unsubscribe tokens, bank-link
tokens, idempotency keys, and API credentials. Their Supabase-side row counts
are **not independently obtainable** through this read-only tool. This is a
deliberate security control in the bridge itself, not a gap introduced by
this task, and it is the right tradeoff — expanding the bridge to expose
these tables would require code changes to a Supabase Edge Function, which is
out of scope for a read-only reconciliation. AWS-side counts for these five
are recorded for completeness (`email_unsubscribe_tokens`: 9,
`homeowner_bank_link_tokens`: 4, `homeowner_ledger_tokens`: 14,
`payment_idempotency_keys`: 4, `tenant_openai_credentials`: 1) but cannot be
compared. **These five tables are BLOCKED/UNKNOWN for this reconciliation.**

## 8. Cleanup performed

- The temporary `checksops-cursor-recon-readonly-temp` Lambda function and its
  IAM-free, role-reused configuration were used strictly read-only (every
  invocation ran inside an explicit read-only transaction with `ROLLBACK`,
  never `COMMIT`) and **have been deleted** after this report was generated.
- No new Supabase Edge Function was created or modified.
- No secret was rotated, created, or exposed. The pre-existing migration
  token (`checksops/staging/storage-migration-token` in Secrets Manager) was
  read (as in prior PR #127 work) to authenticate to the existing bridges;
  it was not logged, printed, or committed anywhere.

## 9. Proposed reconciliation plan — NOT APPLIED

This plan is provided for review only. Nothing in this section has been
executed.

1. **Do not repeat the Cognito identity mistake.** Any future sync must never
   write to `identity_accounts` or any `cognito_sub` column — that table is
   AWS-only and today's repaired values are the baseline (§4.5).
2. **Storage (low risk, additive-only):** copy the 3 Supabase-only objects
   identified in §4.2 to AWS S3 using the existing
   `aws-staging-storage-bridge` `sign` action (the same signed-URL COPY
   mechanism already used and reconciled in PR #92/#127), verify by
   SHA-256/size, and re-run the storage inventory diff to confirm 1,417/1,417
   matched with 0 mismatches. This does not require touching the 45 AWS-only
   test objects.
3. **Database (needs a decision, not just a mechanical copy):** for the rows
   identified in §4.2 (tenant `2eff5f1a`, ids listed there), apply Supabase's
   current values for `check_intake_items`, `check_endorsements`,
   `check_endorsement_events`, `endorsement_audit_log`, `homeowner_ledger_events`,
   `audit_logs`, `stakeholder_account_verification_log`, `external_payment_recipients`,
   `payment_provider_accounts`, `stakeholder_accounts`, `tenant_email_settings`,
   `payment_webhook_events`, `payment_event_log`, and `email_send_log` as the
   authoritative source, using the existing guarded-`UPDATE`/guarded-`INSERT`
   pattern established for the identity repair (row-level `SELECT … FOR
   UPDATE`, verify current AWS state matches the last-known pre-sync
   snapshot before writing, single transaction, full before/after evidence,
   no `COMMIT` unless every row passes its guard). Because §4.3 shows AWS has
   already diverged on a few of these same ids (test-driven `status`
   changes), **the guard must explicitly detect and refuse to silently
   overwrite an AWS state that does not match the expected pre-sync value**,
   surfacing it for manual review rather than blindly force-pushing Supabase's
   value.
4. **Do not touch the 4.1 AWS-only test rows.** They are additive, on a
   distinct id/path space, and do not block a Supabase→AWS one-way sync.
   Whether to eventually clean them out of the shared `checksops` database is
   a separate decision for the team (they do inflate `check_intake_amount`/
   `endorsed_check_intake_amount`/`homeowner_ledger_amount` on the AWS side by
   the amounts in §4.4), not a reconciliation-correctness issue.
5. **Webhook destination:** §4.2‑C is the concrete evidence that Moov is
   still delivering real webhooks to the Supabase endpoint. Do not switch the
   webhook destination to AWS until (a) this database delta is closed so AWS
   has the current provider-account/recipient/stakeholder state that the
   webhook events reference, and (b) AWS's webhook-handling path has been
   validated end-to-end with a real (or realistic replayed) Moov payload —
   this is explicitly called out by the user as a separate, later phase.
6. **Independent of the AWS migration:** flag the two live Supabase-only
   operational issues found in §4.6 (`check_reconciliation_alerts` daily
   `dashboard_count_mismatch` critical alerts, and `glba_security_events`
   daily `retention_purge_error`) to whoever owns Supabase production
   operations. Both have been firing daily for at least 8 days and are
   unresolved.

## 10. Verdict

**RECONCILIATION REQUIRED.**

- It is **not** DATA PARITY: §4.2 documents a concrete, evidenced, real
  production write (a full check-endorsement + CheckAlt-deposit transaction
  and 13+ days of live Moov webhook/onboarding activity for tenant "Freedom
  Adjustment") that reached Supabase and has never reached AWS, plus 3 storage
  objects missing from AWS.
- It is **not** BLOCKED/UNKNOWN overall: the read-only tooling worked, the
  data was fully retrievable, and the gap is precisely enumerated by table and
  row id (with the sole exception of the 5 denylisted tables in §7, which are
  a narrow, intentional, and separately-called-out BLOCKED/UNKNOWN carve-out).
- The gap is **small, well-understood, non-destructive to money movement**
  (§4.4 shows exact parity on every dollar-accurate deposit/disbursement/
  CheckAlt/claim-payment aggregate), and **isolated to one real tenant**. It
  does not, by itself, block continuing to the next phases the user has
  already sequenced (CheckAlt AWS readiness, webhook migration, SPA cutover)
  as long as the plan in §9 (or an equivalent) is executed **before** AWS is
  made authoritative for tenant `2eff5f1a`'s check-endorsement and Moov state,
  and before the Moov webhook destination is switched.

**STOP.** No writes were made. No webhook destinations were changed. The SPA
was not deployed. Awaiting direction on §9 before any reconciliation is
applied.
