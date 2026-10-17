# Fee collection fixes: lock, pin and deploy-order deltas

Branch `claude/fee-collection-fixes`, built on the unmerged release branch `claude/release-2026-10-17`
(head 361dfd8c6). Read this with `ops/release-2026-10-17-lock-pin-deltas.md`: every value there still applies,
except the rows below. They replace that file's values for the same files.

Documentation only. Nothing in `ops/release-locks/` or `ops/deployment-guard/production-api-overlay-plan.json`
is edited. No deploy, workflow run, AWS call or Moov call was made to produce this file. Hashes are sha256
of the branch bytes, plus `node scripts/validate-release-locks.mjs --print-hashes` for locks.

Owner decisions (2026-10-17) this implements: the platform owner collects tenant fees manually from Tenant
Management. There is no automatic or scheduled pull. The amount comes only from the Billing tab rates (SQL 96)
and recorded usage. It is pulled by ACH from the bank account the tenant authorized into the ChecksOps
platform account. There are no amount limits.

## 1. Release locks

| Component | Recorded tree_hash | Branch tree_hash | Why |
|---|---|---|---|
| `provider-secrets` (UNVERIFIED, not production-active) | `e4a20f5b6983f9e66732d87b14c1574701ae2263f03211ee4cdf354ade75ad74` | `6c47674d8446d08eb6e938e33ffc0e58ee7494f4b87442bfbb97a9533152e8f6` | `provider-flags.mjs` now exports `isProductionChecksOpsRuntime` |

No other lock component contains a file this branch changes.

## 2. Lambda files (all would be REPLACE plan members; none is a plan member today)

These replace the section 3 values in the release report where a file is listed there. Files marked "new
here" are not in that report, because the release branch did not change them.

| File (under `aws/functions/api/`) | Branch sha256 | Change |
|---|---|---|
| `provider-flags.mjs` | `6a40bc217a44a5ffe915188a0f796c5274c8ebc65dc633d6c5e84c7832e3d1bd` | new here: exports `isProductionChecksOpsRuntime` |
| `tenant-billing-destination.mjs` | `2e547f9ba81d6c3e0763a90ddfe16289446607d4d8e65483a09fef6a8ac0262c` | new here: static import of the helper, production pin, status and set |
| `tenant-collection-v2.mjs` | `fa635db849bcbe474ad17d9c427272f1279d5cfd96f2363529c90f812ff41247` | new here: `deps.bankOnly` (tenant wallet never debited for fees) |
| `tenant-billing-engine.mjs` | `a7f1b8a8c7368eb13f5209494094178f6587dbb861eaef22bf7435cc377ba234` | replaces `3397c65d…`: preview, hash, lock, audit, scheduler refusal, single per-check default |
| `tenant-billing-handlers.mjs` | `411eafae4422dad748ca294d9c1cc3b3d21a1c5ddb3ec0c389ebd329131da377` | replaces `2866356c…`: preview / pull / destination actions, scheduler 410 |
| `providers/parity/moov-money.mjs` | `0ac52dbde62187d8e93ba229b0f5e4fa3428e84c7f3ba6538c4202242ca68e98` | replaces `b35beaa7…`: `moov-tenant-fee-charge` retired |
| `providers/parity/moov-functions.mjs` | `dc20078ad6ea80841c35bc6c06797c00fd97e4fb57d3527d72048e87536460b8` | replaces `7b0cde12…`: retired handlers answer before identity |
| `providers/catalog.mjs` | `5aa2538f78aa5199f2615c68bd64bbbe3243fa3726ba0e99d12fcf6242f8b3a9` | replaces `6a3bf4e5…`: description only |

Reverse imports: `aws/tests/fixtures/main-api-import-edges.json` now also lists
`tenant-billing-destination.mjs -> provider-flags.mjs isProductionChecksOpsRuntime`. That name was missing on
main and was excluded from the fixture; it is checked now, giving 567 edges. Main's live files keep loading:
`runMonthlyBillingScheduler`, `chargeTenantPeriod`, `tenantFeeCharge` and every other imported name are still
exported. The scheduler now refuses. `chargeTenantPeriod` now requires a preview hash, so main's live
`tenant-billing-handlers.mjs` cannot charge through the new engine without a preview. It gets `preview_required`.

## 3. New SQL pin

| SQL file | source_sha256 (branch) |
|---|---|
| `aws/workflows/sql/98_tenant_fee_collection.sql` | `2be331f5387465520b80729f836bae2cf0db5e62d997aa3a824196d6b8608096` |

It is not pinned yet. It has no `AUTHORIZED_SQL98_*` entry, no production-apply JSON, no ledger entry and no
overlay-plan `sql_prerequisites` entry. It needs a reviewed staging pin with expected live state from a
read-only inspect, then a staging apply, staging acceptance and a production pin. The number is 98, the next
free one after 90-97.

What a read-only inspect must confirm before the pin:
- `check_billing_config` has an active row (or no rows: SQL 98 then seeds 300). The live default price is
  the answer to section 6's question.
- `tenant_maintenance_payments` has no two rows for one `(tenant_id, billing_period)`. SQL 98 refuses with
  `23505 sql98_duplicate_billing_periods` otherwise; reconcile first. Also check whether
  `tenant_maintenance_payments_tenant_period_uidx` already exists (from the earlier billing SQL).
- `check_billing_events` has a unique index on `(check_intake_item_id, event_type)`. The Supabase constraint
  `check_billing_events_check_event_unique` was restored by the DB copy. If it is missing and duplicates exist,
  SQL 98 warns and skips the index.
- The current body of `public.record_check_billing_event()` and `trg_record_check_billing_event`. The DB-copy
  analysis lists the trigger as present on AWS (`aws/db-copy/analysis/TRIGGER_RECONCILIATION.md`); SQL 98
  replaces it.
- The `platform_billing_destination` rows and policies. SQL 98 replaces both policies with platform-owner-only
  ones, which drops the `aws_monthly_billing_job()` read path.

## 4. Deploy order (add to section 5 of the release report)

1. **SQL 98 after SQL 96, before the billing Lambdas.** Without SQL 98, a pull or verify-debit refuses with
   503 `billing_audit_unavailable` before anything is booked or posted. Fail closed, nothing charged.
2. **`provider-flags.mjs` before (or with) `tenant-billing-destination.mjs`.** The new destination file imports
   `isProductionChecksOpsRuntime` statically and would not load against main's `provider-flags.mjs`.
   `provider-flags.mjs` itself only adds an export and imports `identity-env.mjs`, which is unchanged and
   already live.
3. **`tenant-collection-v2.mjs` before (or with) `tenant-billing-destination.mjs`.** The destination file
   imports `assertExplicitDestination` from it; that name is already exported on main, so this is a soft
   dependency.
4. **`tenant-billing-destination.mjs` → `tenant-billing-engine.mjs` → `tenant-billing-handlers.mjs`.** The
   engine imports `COLLECTION_CONTRACT_ID` from collection-v2. The handlers import `MANUAL_BILLING_ONLY` and
   `previewTenantPeriodCharge` from the engine and `billingDestinationStatus` and `setBillingDestination` from
   the destination file. This replaces the release report's single "billing after SQL 96" line.
5. **`providers/parity/moov-money.mjs` and `moov-functions.mjs`** in the parity group (release step 5). Any
   order works. Together they retire `moov-tenant-fee-charge` (410 `use_tenant_billing_pull`).
6. **SPA** (one build, after the Lambdas above): `AdminTenants.tsx`, `TenantFeeCollection.tsx`,
   `tenantFeeBilling.ts`. Its buttons call `tenant-billing-admin` `preview` / `pull` / `verify-debit` /
   `destination-get` / `destination-set`. An SPA in front of the old handlers would get `unknown_action` for
   the destination actions and `preview_required` for pulls. It fails closed.
7. **Supabase edge function** `supabase/functions/moov-tenant-fee-charge` now only answers 410. It is not
   deployed by this change; deploy it only through the Supabase path, if that is still live.

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

## 6. Needs owner input

- **Platform Moov destination ids.** Production fees are pinned to the account and payment method that
  `tenant-collection-v2.mjs` already requires: account `41cb5d67-4911-4bef-aad5-d8ee9c582208`, wallet payment
  method `c70a90f2-9bcc-4084-8263-d5a0fb5d806c`. They were identified read-only from tenant wallet
  `partnerAccountID` values (`tenant-billing-destination.mjs`), not confirmed by the owner. Confirm them, then
  set them once from Tenant Management, Billing & Usage, Fee destination. If the platform's own bank account
  should receive the fees instead of the wallet, both pins (here and in `assertExplicitDestination`) must
  change. Sandbox is pinned to the ChecksOps sandbox merchant `36b79957-ce7a-4ca7-a68f-30986c9e47bb`; the
  sandbox payment method id still has to be entered.
- **The live `check_billing_config` price.** The repo cannot show which per-check price production charged
  historically; read it in section 3's inspect. What the code does show:
  - The charged amount always came from each event's stamped `unit_price_cents`. The Supabase trigger
    stamped the tenant rate when per-check billing was on, otherwise the active `check_billing_config` price
    (seed 300).
  - The Supabase Tenant Management total summed those stamped prices.
  - The `$4.00` was only a display label in `AdminTenants.tsx` and the engine's display/readiness fallback
    (`DEFAULT_CHECK_RATE_CENTS = 400`). It never priced an event.
- **Per-check billing off still bills.** The ported trigger keeps the Supabase behavior: with per-check billing
  off, a deposited check is still billed at the default price. "Per-check billing on" only means the tenant's
  own rate is used. If "off" should mean no per-check fee, the trigger and the engine need one more change.
- **Invoice email.** The retired `moov-tenant-fee-charge` emailed an invoice after a pull. The
  `tenant-billing-admin` pull does not send one.
- **Live RLS for the pull's writes.** On staging, `tenant_maintenance_payments`, `payment_transfers` and
  `check_billing_events` write policies were reconciled toward `aws_can_write_tenant` (guarded SQL 39), which a
  non-member platform owner does not pass. A staging UAT pull must confirm that the owner's writes go through,
  or that a reviewed server-writer path is added. This change adds no new bypass.
