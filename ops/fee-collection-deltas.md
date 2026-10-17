# Fee collection fixes: lock, pin and deploy-order deltas

Branch `claude/fee-collection-fixes`. It was built on the release branch head `361dfd8c6`, then merged with `main` at
`e2ca97bc2` (release #1015). Read this with `ops/release-2026-10-17-lock-pin-deltas.md`: every value there still
applies, except the rows below. They replace that file's values for the same files.

No deploy, workflow run, AWS call or Moov call was made to produce this file. Hashes are sha256 of the branch
bytes, plus `node scripts/validate-release-locks.mjs --print-hashes` for locks.

Owner decisions (2026-10-17) this implements: the platform owner collects tenant fees manually from Tenant
Management. There is no automatic or scheduled pull. The amount comes only from the Billing tab rates (SQL 96)
and recorded usage. It is pulled by ACH from the bank account the tenant authorized into the ChecksOps
platform account. There are no amount limits.

## 1. Release locks: no change

`node scripts/validate-release-locks.mjs` passes with no lock edit. Owner decision (2026-10-17, option A): there is
no `provider-secrets` lock change. `aws/functions/api/provider-flags.mjs` is byte-identical to `main`
(`122b8769…`). `isProductionChecksOpsRuntime` is defined and exported in `tenant-billing-destination.mjs`, its
only user, on `identity-env.mjs` `identityEnvFromChecksopsEnv` and `IDENTITY_ENV_PRODUCTION`. Both names are
already exported by the live production `identity-env.mjs` (snapshot `f78e16d99`) and by `main`, so
`identity-env.mjs` is neither changed nor a plan member, and no deploy-order constraint is added.
`identity-env.mjs` is the right base rather than the new home: live `identity-env.mjs` differs from `main`
(the release changed it) and is not a plan member, so adding an export there would mean planning a REPLACE of
live bytes that main never carried. No lock component contains a file this branch changes.

## 2. Overlay plan (`ops/deployment-guard/production-api-overlay-plan.json`)

Eight members take the branch bytes under `aws/tests/fixtures/production-fee-collection-pin-manifest-2026-10-17.json`.
Planning only: `deploy_authorized` is false and nothing is live or verified.

| Member (under `aws/functions/api/`) | expected live | accepted (branch) | sql_before | Live provenance |
|---|---|---|---|---|
| `providers/parity/moov-functions.mjs` | `2dff151e…` | `dc20078ad6ea80841c35bc6c06797c00fd97e4fb57d3527d72048e87536460b8` | – | release manifest (unapplied) |
| `providers/parity/moov-money.mjs` | `1cd405ca…` | `0ac52dbde62187d8e93ba229b0f5e4fa3428e84c7f3ba6538c4202242ca68e98` | – | release manifest (unapplied) |
| `providers/catalog.mjs` | `ae788992…` | `5aa2538f78aa5199f2615c68bd64bbbe3243fa3726ba0e99d12fcf6242f8b3a9` | – | release manifest (unapplied) |
| `tenant-collection-v2.mjs` (new member) | `8a66f54d3c2785162a1643218e18b4d3c251230cf2a7f98a1ecb4ede8939fb66` | `6b4a415fe38a49243f31a2ab9495ab72bc62e1f1e69afae37c48d67147e2a20a` | – | 2026-10-11 snapshot `f78e16d99` |
| `tenant-billing-destination.mjs` (new member) | `7f9f24569d8d3112bcb829380de17b56ac5076fe8a8b38fd6a7633b44bcdfd80` | `dce1f7eb0e461fb70e41748952a9e915ce15a828ae14a86f819d36355ac19e69` | – | 2026-10-11 snapshot (= main) |
| `tenant-fee-invoice-email.mjs` (new file, ADD) | – (absent) | `fedc59335cef47c6bd353b38967dbf815f2931bc9308e4aac41664267b5e1374` | – | not in the live bundle or main |
| `tenant-billing-engine.mjs` | `65b75735…` | `c8f92ca63d994d38ae5e829580b0292951c22b7558fbc6f6f6f186c31bacbd0b` | SQL 98 (was 96) | release manifest (unapplied) |
| `tenant-billing-handlers.mjs` | `8aeb8b7f…` | `c4a0841518ed05d5bcf35358873622d5c4fc4ec9d087f214ba104697b5de09c7` | SQL 98 (was 96) | release manifest (unapplied) |

Order: `tenant-collection-v2.mjs`, `tenant-billing-destination.mjs` and the new `tenant-fee-invoice-email.mjs` go
just before `tenant-billing-engine.mjs`, in that order (they are also added to the
`guarded-production-lambda-overlay.yml` member choices). The invoice email module imports the destination file
(and, from the live bundle, `email.mjs` `sendViaSesOrSink`, `email-layout.mjs` `renderChecksOpsEmail`,
`email-policy.mjs` `normalizeEmail`, plus `email-branding.mjs`, which is planned earlier), and the engine imports
it, so it must be live before the engine. The parity files and
`providers/catalog.mjs` keep their places. `providers/production/moov-send.mjs` and `providers.mjs` stay last.

- `tenant-collection-v2.mjs` must go before the engine. It holds `PRODUCTION_FEE_DESTINATION` (which the new
  destination file imports) and `bankOnly`. Against live collection-v2 the new engine's `bankOnly` would be
  ignored, and the tenant wallet would be debited first. Live lacks only main's `obligation_status` return field,
  so the branch bytes are a superset of live.
- `provider-flags.mjs` is main's bytes and **not** a plan member. Live carries `moovTransferPostEnabled` and an
  `AWS_MOOV_TRANSFER_POST_ENABLED` `flagSnapshot` field that main lacks (release report item 4). The new
  destination file no longer imports `provider-flags.mjs` at all.
- `identity-env.mjs` is not a plan member: the destination imports only names it already exports live.

Reverse imports: `aws/tests/fixtures/main-api-import-edges.json` is main's again. Main's live
`tenant-billing-destination.mjs` dynamically imports `isProductionChecksOpsRuntime` from `provider-flags.mjs`.
That name is missing on main and exported by live `provider-flags.mjs`; main already excluded the edge, and the
overlay replaces the destination file without touching `provider-flags.mjs`. Main's live files keep
loading: `runMonthlyBillingScheduler`, `chargeTenantPeriod`, `tenantFeeCharge` and every other imported name
are still exported. The scheduler now refuses. `chargeTenantPeriod` requires a preview hash, so main's live
`tenant-billing-handlers.mjs` cannot charge through the new engine without a preview (`preview_required`).

## 3. SQL 98 pending pin

| SQL file | source_sha256 (branch) | Authoring commit |
|---|---|---|
| `aws/workflows/sql/98_tenant_fee_collection.sql` | `7db0fe4939f1faa2e9967f608aafad95b61bf6bac5bc1fcbca545a8d37117e29` | `2014129d3265b284c6236012484e3649a332634f` |

The number is 98, the next free one (main ends at 97). It is pinned as pending:
- `ops/deployment-guard/sql98-tenant-fee-collection-production-apply.json`: `authorization: pending`,
  `execute: false`, predecessor `sql96`, no expected live definition;
- `scripts/deployment-guard/lib/sql-executor-auth.mjs` `AUTHORIZED_SQL98_TENANT_FEE_COLLECTION`
  (`FEE_COLLECTION_PENDING_SQL_PINS`), not in the staging executor MIGRATIONS or workflow choices;
- plan `sql_prerequisites` entry with `verified_live: false`.

No tooling, ledger entry, staging apply or production apply exists. SQL 98 now refuses without SQL 96's
`aws_platform_owner_set_tenant_pricing(uuid, jsonb)`, so "SQL 98 verified live" implies SQL 96 is live.

What a read-only inspect must confirm before an execute pin:
- `check_billing_config` has an active row, or no rows (SQL 98 then seeds 300). The live default price is
  the answer to owner question (b)'s price.
- `tenant_maintenance_payments` has no two rows for one `(tenant_id, billing_period)`. SQL 98 refuses with
  `23505 sql98_duplicate_billing_periods` otherwise; reconcile first. Also check whether
  `tenant_maintenance_payments_tenant_period_uidx` already exists (from the earlier billing SQL).
- `check_billing_events` has a unique index on `(check_intake_item_id, event_type)`. The Supabase constraint
  `check_billing_events_check_event_unique` was restored by the DB copy. If it is missing and duplicates exist,
  SQL 98 warns and skips the index.
- The current body of `public.record_check_billing_event()` and `trg_record_check_billing_event`. The DB-copy
  analysis lists the trigger as present on AWS (`aws/db-copy/analysis/TRIGGER_RECONCILIATION.md`); SQL 98
  replaces it.
- Every policy and grant on `platform_billing_destination`. SQL 98 now drops every policy except its two
  platform-owner ones and resets `checksops` to SELECT, INSERT, UPDATE. This removes the `aws_monthly_billing_job()`
  read path and any other permissive policy.

## 4. Deploy order (add to section 5 of the release report)

1. **SQL 96, then SQL 98, before the billing Lambdas.** Enforced by SQL 98's prerequisite check and the plan's
   `sql_before`. Without SQL 98 a pull or verify-debit refuses with 503 `billing_audit_unavailable` before
   anything is booked or posted. It fails closed and nothing is charged.
2. **`tenant-collection-v2.mjs` → `tenant-billing-destination.mjs` → `tenant-billing-engine.mjs` →
   `tenant-billing-handlers.mjs`** (plan order; the overlay refuses a member while an earlier one is pending).
3. **`providers/parity/moov-money.mjs` and `moov-functions.mjs`** in the parity group (release step 5). Any
   order works. Together they retire `moov-tenant-fee-charge` (410 `use_tenant_billing_pull`).
4. **SPA** (one build, after the Lambdas above): `AdminTenants.tsx`, `TenantFeeCollection.tsx`,
   `tenantFeeBilling.ts`. Its buttons call `tenant-billing-admin` `preview` / `pull` / `verify-debit` /
   `destination-get` / `destination-set`. An SPA in front of the old handlers gets `unknown_action` for the
   destination actions and `preview_required` for pulls, so it fails closed.
5. **Supabase edge function** `supabase/functions/moov-tenant-fee-charge` now only answers 410. This change does not
   deploy it; deploy it only through the Supabase path, if that is still live.

## 5. Flags (unchanged, still unset in every template)

`AWS_MOOV_MONTHLY_BILLING_ENABLED`, `AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST`,
`AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED` and `AWS_MOOV_BILLING_DESTINATION_*` are not in
`aws/template.yaml`, `aws/production/api-template.yaml` or `aws/production/api-cfn.yaml`, and a test keeps it
that way. With `AWS_MOOV_MONTHLY_BILLING_ENABLED` unset, every pull answers `monthly_billing_disabled`.
Production also refuses before booking:
- a pull, with `production_billing_post_disabled`, unless `AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST=true`;
- a $1 verification, with `verification_post_disabled`, unless
  `AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED=true`.

`AWS_MOOV_MONTHLY_BILLING_SIMULATE` can no longer make production book a simulated charge.

New: `AWS_TENANT_FEE_INVOICE_EMAIL_ENABLED` (invoice email after a pull). `true` / `false` win; unset means
**on** everywhere except the production runtime and **off on production** until the owner sets it to `true`.
It is in no template (a test keeps it out). Delivery still follows `email-policy.mjs` (`AWS_EMAIL_MODE`, sink by
default, allowlist in SES mode).

## 6. Owner questions (answered on PR #1017, 2026-10-17)

- **(a) Fee destination: ANSWERED, owner-confirmed.** The platform Moov wallet in platform Moov account
  `41cb5d67-4911-4bef-aad5-d8ee9c582208`. `tenant-collection-v2.mjs` `PRODUCTION_FEE_DESTINATION` already
  pinned exactly that account (`CHECKSOPS_PLATFORM_ACCOUNT_ID`); it is now `ownerConfirmed: true`
  (`ownerConfirmedAt: '2026-10-17'`). No id changed. The wallet payment method id
  `c70a90f2-9bcc-4084-8263-d5a0fb5d806c` was not part of the answer and stays `paymentMethodOwnerConfirmed: false`
  (the destination status reports both). Sandbox stays pinned to the ChecksOps sandbox merchant
  `36b79957-ce7a-4ca7-a68f-30986c9e47bb`.
- **(b) Per-check billing switched off: ANSWERED, NOT IMPLEMENTED: needs an owner decision on existing data.**
  Owner rule: off means the tenant cannot make deposits and is never charged a per-check fee. Finding:
  `tenants.per_check_billing_enabled` was added as `BOOLEAN DEFAULT false`
  (`supabase/migrations/20260605162924_*.sql`), so every tenant that existed then is `false` (not null), and every
  tenant created since is `false` unless the owner turned it on. SQL 96 does not change the column or its
  default. `false` has meant "bill the `check_billing_config` default price" (the Supabase trigger, and SQL 98
  today), and `CheckUsageCard.tsx` uses `true` to mean "show per-check amounts to the tenant". A gate on `false`
  would stop deposits for practically every tenant, and "off = no fee" would make them all free. "Treat null as
  on" does not help, because the values are `false`, and a backfill is out of scope. Behavior is unchanged: the
  SQL 98 switch `aws_check_billing_charges_when_per_check_off()` (true) and `PER_CHECK_OFF_BILLS_DEFAULT_PRICE`
  stay, and no deposit path is gated yet. Options for the owner:
  1. an owner-approved data change that sets existing tenants to `true` and changes the column default to `true`,
     then the gate and no-fee rule as specified (SQL 96 column, no new state);
  2. a separate, explicit owner-only "deposits enabled" switch, with per-check billing off still meaning the
     default price;
  3. treat only an explicit owner switch-off recorded in `tenant_pricing_audit` as "off" (no data change, but a
     legacy `false` tenant cannot be switched off with one save, because the setter audits only changes).
  The gate is ready to place once decided: every deposit-creating path goes through two server choke points,
  `providers.mjs` `handleFunctionInvoke` (`checkalt-submit-deposit`, `checkalt-approve-deposit` action
  `approve`, production and sandbox, before any provider call) and `workflow-rpc.mjs` `deposit_action`
  (`prepare_deposit`, `assign_provider`, `mark_manual_deposit`). Generic `/data/write` cannot set `status`,
  `deposited_at` or deposit tables, admin override to `deposited` is disabled, and the deposit cron is off. A
  database backstop on INSERT into `checkalt_deposits` / `deposit_items` would cover any other writer.
- **(c) Invoice email after a pull: ANSWERED yes, built** (`aws/functions/api/tenant-fee-invoice-email.mjs`).
  - When: only after a pull whose ACH debit was submitted. Never on a preview, refusal, mismatch, duplicate pull
    or the $1 verification.
  - Once: keyed on the charge (`fee-invoice:<tenant_maintenance_payments.id>`). A `sent` / `sunk` outcome is an
    `invoice_email` row in `platform_billing_audit`, and SQL 98's unique index
    `platform_billing_audit_invoice_email_once_uidx` allows one per charge. It is also logged in `email_send_log`
    with the same key and the usual statuses.
  - How: the existing AWS path, `sendViaSesOrSink` (SES, or the staging sink / allowlist), from the ChecksOps
    address (`platformBranding`), with the tenant's name and logo (`resolveEmailBranding`) in the shared
    ChecksOps layout.
  - Recipient: the member who authorized the ACH debit (`tenant_billing_accounts.ach_authorized_by` →
    `identity_accounts.email`), the billing contact who consented to the charge. Fallback is
    `tenants.company_email` (SQL 93). Users-only roles (SQL 90) mean there is no owner role to choose.
  - Contents: tenant name, period, date, booked lines, total, and the last four digits of the account. No
    account, routing or provider ids, and no other personal data.
  - Failure isolation: everything runs inside a savepoint, so a failed email never fails or rolls back the
    pull. The failure is audited (`failed` / `no_recipient`), and the platform owner can resend
    (`tenant-billing-admin` `invoice-resend`, the SPA's "Resend invoice email"), still at most once per charge.
  - Limit: the email goes out before the pull's transaction commits. If the commit itself then fails, the
    charge is rolled back but the email was sent.

Also still open (from the earlier review): **live RLS for the pull's writes.** On staging,
`tenant_maintenance_payments`, `payment_transfers` and `check_billing_events` write policies were reconciled
toward `aws_can_write_tenant` (guarded SQL 39), which a non-member platform owner does not pass. A staging UAT
pull must confirm that the owner's writes go through, or that a reviewed server-writer path is added. This change
adds no new bypass.

## 7. Review fixes after the merge

- `preview_hash` v2 also binds the fee destination and the tenant's authorized funding source, so a preview
  cannot be replayed after either changes, even at the same amount.
- Preview and pull require positive safe-integer cents (`invalid_amount_cents`) before booking.
- The $1 verification debit applies the pull's bank-source rules (`assertTenantBankSource`).
- SQL 98 fails closed on unknown live `platform_billing_destination` policies and grants (see section 3).
- SQL 98 requires SQL 96.
