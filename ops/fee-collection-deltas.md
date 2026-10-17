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

Seven members take the branch bytes under `aws/tests/fixtures/production-fee-collection-pin-manifest-2026-10-17.json`.
Planning only: `deploy_authorized` is false and nothing is live or verified.

| Member (under `aws/functions/api/`) | expected live | accepted (branch) | sql_before | Live provenance |
|---|---|---|---|---|
| `providers/parity/moov-functions.mjs` | `2dff151e…` | `dc20078ad6ea80841c35bc6c06797c00fd97e4fb57d3527d72048e87536460b8` | – | release manifest (unapplied) |
| `providers/parity/moov-money.mjs` | `1cd405ca…` | `0ac52dbde62187d8e93ba229b0f5e4fa3428e84c7f3ba6538c4202242ca68e98` | – | release manifest (unapplied) |
| `providers/catalog.mjs` | `ae788992…` | `5aa2538f78aa5199f2615c68bd64bbbe3243fa3726ba0e99d12fcf6242f8b3a9` | – | release manifest (unapplied) |
| `tenant-collection-v2.mjs` (new member) | `8a66f54d3c2785162a1643218e18b4d3c251230cf2a7f98a1ecb4ede8939fb66` | `4be03294ca832de29e57b51958d00681568601b1d8c533776a22d5538d5fa3c9` | – | 2026-10-11 snapshot `f78e16d99` |
| `tenant-billing-destination.mjs` (new member) | `7f9f24569d8d3112bcb829380de17b56ac5076fe8a8b38fd6a7633b44bcdfd80` | `44c6525c8f6d9216f7f41abc28ae9582ccaa5ee21506c3ba93f49f51881f768d` | – | 2026-10-11 snapshot (= main) |
| `tenant-billing-engine.mjs` | `65b75735…` | `a823c7c1177475668713900d6fc4f34909f6148f728d5f1fe3421929c012a6ee` | SQL 98 (was 96) | release manifest (unapplied) |
| `tenant-billing-handlers.mjs` | `8aeb8b7f…` | `411eafae4422dad748ca294d9c1cc3b3d21a1c5ddb3ec0c389ebd329131da377` | SQL 98 (was 96) | release manifest (unapplied) |

Order: `tenant-collection-v2.mjs` and `tenant-billing-destination.mjs` go just before `tenant-billing-engine.mjs`
(they are also added to the `guarded-production-lambda-overlay.yml` member choices). The parity files and
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
| `aws/workflows/sql/98_tenant_fee_collection.sql` | `668b072048494bff275ac2b803dfb1d2252f5cfc393591e97ff85478039e71e9` | `0d7917b9601de1fe8d5d1ff337cd23e0134443ce` |

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

## 6. Open owner questions (isolated defaults; behavior unchanged until answered)

- **(a) Fee destination: platform Moov wallet or a bank account, and which platform Moov account?**
  The one place is `aws/functions/api/tenant-collection-v2.mjs` `PRODUCTION_FEE_DESTINATION`. Default:
  `kind: 'platform_moov_wallet'`, account `41cb5d67-4911-4bef-aad5-d8ee9c582208`, wallet payment method
  `c70a90f2-9bcc-4084-8263-d5a0fb5d806c`, `ownerConfirmed: false`. These were identified read-only from tenant
  wallet `partnerAccountID` values, not confirmed by the owner. `assertExplicitDestination` and the
  destination pins both read this object. Sandbox stays pinned to the ChecksOps sandbox merchant
  `36b79957-ce7a-4ca7-a68f-30986c9e47bb`.
- **(b) Does per-check billing "off" mean no per-check fee?** Default: no. Off still bills the
  `check_billing_config` default per deposited check (the Supabase behavior); "on" only means the tenant's own
  rate is used. The switches are `public.aws_check_billing_charges_when_per_check_off()` in SQL 98 (returns
  `true`), which decides the stamped price, and `PER_CHECK_OFF_BILLS_DEFAULT_PRICE` in
  `tenant-billing-engine.mjs`, which mirrors it for display. Change both together.
- **(c) Should the invoice email come back?** Default: no. `INVOICE_EMAIL_AFTER_PULL = false` in
  `tenant-billing-engine.mjs`, and the pull reports `invoice_email_sent: false`. The retired
  `moov-tenant-fee-charge` emailed one through Supabase `send-transactional-email`; no AWS invoice sender is
  wired, so turning this on needs that sender first.

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
