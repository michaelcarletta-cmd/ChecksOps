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

## 1. Release locks: no change (one pending, not applied)

`node scripts/validate-release-locks.mjs` passes with no lock edit. One lock change is pending owner approval and
is not in this branch: the tenant-side deposit buttons in `src/pages/CheckCommandCenter.tsx` (locked
`partner-sharing` group) would change `components.partner-sharing.source.tree_hash` from
`0ab1c642cc90fa269da6295573ff4f1c3a148d34df99e2dd770322fe8c7d1d9e` to
`8fd46704e298502ffede4279c114efe8c75114873768c70a9e76390d5f246bbc` (section 6 (b)). Owner decision (2026-10-17, option A): there is
no `provider-secrets` lock change. `aws/functions/api/provider-flags.mjs` is byte-identical to `main`
(`122b8769…`). `isProductionChecksOpsRuntime` is defined and exported in `tenant-billing-destination.mjs`, its
only user, on `identity-env.mjs` `identityEnvFromChecksopsEnv` and `IDENTITY_ENV_PRODUCTION`. Both names are
already exported by the live production `identity-env.mjs` (snapshot `f78e16d99`) and by `main`, so
`identity-env.mjs` is neither changed nor a plan member, and no deploy-order constraint is added.
`identity-env.mjs` is the right base rather than the new home: live `identity-env.mjs` differs from `main`
(the release changed it) and is not a plan member, so adding an export there would mean planning a REPLACE of
live bytes that main never carried. No lock component contains a file this branch changes.

## 2. Overlay plan (`ops/deployment-guard/production-api-overlay-plan.json`)

Eleven members take the branch bytes under `aws/tests/fixtures/production-fee-collection-pin-manifest-2026-10-17.json`.
Planning only: `deploy_authorized` is false and nothing is live or verified.

| Member (under `aws/functions/api/`) | expected live | accepted (branch) | sql_before | Live provenance |
|---|---|---|---|---|
| `providers/parity/moov-functions.mjs` | `2dff151e…` | `fbefc70eac342dc2bcb495501643b932ea370a228713b08349517031ff15b094` | – | release manifest (unapplied) |
| `providers/parity/moov-money.mjs` | `1cd405ca…` | `0ac52dbde62187d8e93ba229b0f5e4fa3428e84c7f3ba6538c4202242ca68e98` | – | release manifest (unapplied) |
| `providers/catalog.mjs` | `ae788992…` | `5aa2538f78aa5199f2615c68bd64bbbe3243fa3726ba0e99d12fcf6242f8b3a9` | – | release manifest (unapplied) |
| `tenant-collection-v2.mjs` (new member) | `8a66f54d3c2785162a1643218e18b4d3c251230cf2a7f98a1ecb4ede8939fb66` | `6b4a415fe38a49243f31a2ab9495ab72bc62e1f1e69afae37c48d67147e2a20a` | – | 2026-10-11 snapshot `f78e16d99` |
| `tenant-billing-destination.mjs` (new member) | `7f9f24569d8d3112bcb829380de17b56ac5076fe8a8b38fd6a7633b44bcdfd80` | `dce1f7eb0e461fb70e41748952a9e915ce15a828ae14a86f819d36355ac19e69` | – | 2026-10-11 snapshot (= main) |
| `tenant-fee-invoice-email.mjs` (new file, ADD) | – (absent) | `c7c1921bd6be6d311f1d81235911f79a55f0d1bbd1f7b4f9a5365d1324052dc2` | – | not in the live bundle or main |
| `tenant-billing-engine.mjs` | `65b75735…` | `7c2eedd32aebc26630339817b07321afc4da64a915601083746f80d8f0c50d1b` | SQL 98 (was 96) | release manifest (unapplied) |
| `tenant-billing-handlers.mjs` | `8aeb8b7f…` | `231be3d3068afbf88a6b77f22c0f84ad58ecd7bbe86f63a1300f87f24a71c6a7` | SQL 98 (was 96) | release manifest (unapplied) |
| `tenant-deposits-gate.mjs` (new file, ADD) | – (absent) | `0b9942462b5d78a5cff9f5f78145b0a15fc398b3d2b8160966004f4fa9f60b95` | – | not in the live bundle or main |
| `workflow-rpc.mjs` (moved from the release manifest) | `9a630bdb…` | `79b7e4de653eb9d391afca9d27769b3b7c8e3d10d67af43e829ee32398797485` | SQL 98 (was 90) | release manifest (unapplied) |
| `providers.mjs` (moved from the release manifest) | `6ad4c7ec…` | `af6309a083b6c4f7805c13489caa036339ca3523f4a425c001eaf32c2fa6bacc` | SQL 98 (was none) | release manifest (unapplied) |

Deposits switch: `tenant-deposits-gate.mjs` goes just before `workflow-rpc.mjs` (its first importer).
`workflow-rpc.mjs` (`deposit_action`) and `providers.mjs` (Check Alt submit / approve) import it and are held for
SQL 98, because the gate fails closed without SQL 98's reader `aws_tenant_deposits_enabled(uuid)`. Deploying
either before SQL 98 would refuse every deposit (production has the Check Alt execution flags on, so the gate runs
there). SQL 98 requires SQL 96, which requires SQL 90 and SQL 93, so the new hold also covers `workflow-rpc.mjs`'s
former SQL 90 hold. **This couples the release's last member, `providers.mjs`, to SQL 98** (which has no guarded
apply tooling yet).

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
| `aws/workflows/sql/98_tenant_fee_collection.sql` | `5a42e485c84f7c9976390d12c275cdf32612fbba7656b66f553110c0ae697c2a` | `567772a9034cae4ec4d7c56b07c983fb4e797103` |

The number is 98, the next free one (main ends at 97). It is pinned as pending:
- `ops/deployment-guard/sql98-tenant-fee-collection-production-apply.json`: `authorization: pending`,
  `execute: false`, predecessor `sql96`, no expected live definition;
- `scripts/deployment-guard/lib/sql-executor-auth.mjs` `AUTHORIZED_SQL98_TENANT_FEE_COLLECTION`
  (`FEE_COLLECTION_PENDING_SQL_PINS`), not in the staging executor MIGRATIONS or workflow choices;
- plan `sql_prerequisites` entry with `verified_live: false`.

No tooling, ledger entry, staging apply or production apply exists. SQL 98 now refuses without SQL 96's
`aws_platform_owner_set_tenant_pricing(uuid, jsonb)`, so "SQL 98 verified live" implies SQL 96 is live.

Update (claude/sql98-100-apply-tooling): SQL 98 now has guarded tooling on the SQL 90-97 engine:
the staging executor choice `sql98-tenant-fee-collection`, the production tool
`scripts/deployment-guard/sql98-tenant-fee-collection-production-apply.mjs` (`--inspect`), the
one-shot key `sql98`, a code-derived `intended_replacement_sha256` (`abcb8f21…`) in both pins and
the runbook `ops/production-sql-90-97-apply.md`. Both pins stay `execute: false` /
`authorization: pending`; nothing was applied. The inspect reports the checks below (counts,
the covering unique index, the tenant period index, the destination table).

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

1. **SQL 96, then SQL 98, before the billing Lambdas, `workflow-rpc.mjs` and `providers.mjs`.** Enforced by SQL
   98's prerequisite check and the plan's `sql_before`. Without SQL 98 a pull or verify-debit refuses with 503
   `billing_audit_unavailable` before anything is booked or posted, and every deposit refuses with
   `deposits_status_unavailable`. Both fail closed: nothing is charged or deposited.
2. **`tenant-deposits-gate.mjs` (ADD) before `workflow-rpc.mjs`; `tenant-collection-v2.mjs` →
   `tenant-billing-destination.mjs` → `tenant-fee-invoice-email.mjs` (ADD) → `tenant-billing-engine.mjs` →
   `tenant-billing-handlers.mjs`; `providers.mjs` last** (plan order; the overlay refuses a member while an
   earlier one is pending).
3. **`providers/parity/moov-money.mjs` and `moov-functions.mjs`** in the parity group (release step 5). Any
   order works. Together they retire `moov-tenant-fee-charge` (410 `use_tenant_billing_pull`).
4. **SPA** (one build, after the Lambdas above): `AdminTenants.tsx`, `TenantFeeCollection.tsx`,
   `tenantFeeBilling.ts`, `TenantDepositsSwitch.tsx`, `tenantDeposits.ts`, `DepositsDisabledNotice.tsx`,
   `DepositOperationsConsole.tsx`, `CheckAltSettings.tsx`. Its buttons call `tenant-billing-admin` `preview` / `pull` / `verify-debit` /
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
- **(b) Deposits switch: ANSWERED, option 2, built.** A separate platform-owner switch. Per-check billing is
  unchanged: `per_check_billing_enabled` off still means "bill the `check_billing_config` default price"
  (`aws_check_billing_charges_when_per_check_off()` true, `PER_CHECK_OFF_BILLS_DEFAULT_PRICE`), and nothing is
  gated on it.
  - Column (SQL 98 section 5): `tenants.deposits_enabled boolean NOT NULL DEFAULT true`. `ADD COLUMN … NOT NULL
    DEFAULT true` sets every existing tenant to `true` in the same statement (no backfill), and every new tenant
    defaults on.
  - Writer: only the platform owner, through `public.aws_platform_owner_set_tenant_deposits_enabled(uuid,
    boolean)` (SECURITY DEFINER, refuses anyone else with 42501, like SQL 96's pricing setter). It is called from
    Tenant Management by `tenant-billing-admin` `update` with `deposits_enabled` (`saveBillingSettings`). Every
    change, by any path, is audited in `tenant_pricing_audit` (field `deposits_enabled`, old → new, actor) by the
    AFTER UPDATE trigger `aws_tenant_deposits_enabled_audit`.
  - Members cannot change it. SQL 98 replaces SQL 96's `aws_tenants_member_column_guard()` with the same body
    plus `deposits_enabled` in the platform owner's list only (a one-line difference). A member's or partner's
    write is refused (42501 / no row), the generic tenants allowlist and `executeTenantsNarrow` do not carry the
    column, and the SQL 96 pricing setter refuses it (`invalid_field`). Re-running SQL 96 after SQL 98 would put
    back SQL 96's guard; that fails closed (the owner could not change the switch) until SQL 98 is re-run.
  - Reader: `public.aws_tenant_deposits_enabled(uuid)` (DEFINER; NULL for no such tenant).
  - Gate (`aws/functions/api/tenant-deposits-gate.mjs`): reads the flag for the check's own tenant inside a
    savepoint. When the flag is `false` it refuses with `deposits_disabled`, "Deposits are turned off for this
    account. Contact ChecksOps." A read failure is refused (`deposits_status_unavailable`, 503). True or an
    unknown tenant behaves as before. Gated paths:
    1. `providers.mjs` `handleFunctionInvoke`: `checkalt-submit-deposit`, and `checkalt-approve-deposit` with
       action `approve` (reject is not gated), for production Check Alt (only when the money holds would let the
       handler run) and for the sandbox parity handlers, before the handler and any provider call;
    2. `workflow-rpc.mjs` `deposit_action` `prepare_deposit`, after the check's tenant is resolved and before
       `deposit_items` is written;
    3. `deposit_action` `assign_provider`, before the batch is created or the item updated;
    4. `deposit_action` `mark_manual_deposit`, before the item, batch and check are updated.
  - Nothing else creates a deposit. The only INSERTs into `deposit_items` / `deposit_batches` /
    `checkalt_deposits`, and the only `status = 'deposited'` writes, are in `workflow-rpc.mjs` and the Check Alt
    production writer, whose only caller is the gated submit handler. Generic `/data/write` cannot set `status`,
    `deposited_at` or the deposit tables. Admin override to `deposited` is disabled, and the deposit cron is off.
    A test keeps that list fixed.
  - SPA: Tenant Management has a "Deposits enabled" switch ("When off, this tenant cannot submit or record check
    deposits."). The tenant side shows the notice and disables the actions in Deposit Ops (Prepare, Assign Route,
    Deposited, Submit / Resubmit Deposit) and Approve in the Check Alt approval queue.
  - **Not done (locked file):** the Check Command Center deposit buttons (`src/pages/CheckCommandCenter.tsx`
    "Deposit", "Move to Deposited", "Mark as Deposited"). That file is in the locked `partner-sharing` group.
    The edit changes `components.partner-sharing.source.tree_hash` from
    `0ab1c642cc90fa269da6295573ff4f1c3a148d34df99e2dd770322fe8c7d1d9e` to
    `8fd46704e298502ffede4279c114efe8c75114873768c70a9e76390d5f246bbc`, which needs the owner's approval. Until
    then those buttons stay enabled, and the server refuses them with the message above.
- **(c) Invoice email after a pull: ANSWERED yes, built** (`aws/functions/api/tenant-fee-invoice-email.mjs`).
  - Ordering (outbox, review fix): nothing is sent inside the pull's transaction. That transaction books the
    charge and queues one `tenant_fee_invoice_outbox` row (`pending`, keyed on the charge), committed together.
    After the commit, `tenant-billing-handlers.mjs` claims the row (`sending`) in its own transaction, sends with
    no transaction open, then records the outcome (`sent` / `sunk` / `failed` / `no_recipient`) plus
    `email_send_log` and audit rows in another transaction.
    - A failed commit leaves no row, so no email.
    - A crash between the commit and the claim leaves `pending`: the owner's resend sends it once.
    - A crash after the claim leaves `sending` (delivery unconfirmed): it is never resent automatically; the owner
      may release it with `confirm_unsent` after checking the send log.
    - `sent` / `sunk` is final, and SQL 98's unique index allows one `sent` / `sunk` audit row per charge.
  - When: only after a pull whose ACH debit was submitted. Never on a preview, refusal, mismatch, duplicate pull
    or the $1 verification.
  - How: the existing AWS path, `sendViaSesOrSink` (SES, or the staging sink / allowlist), from the ChecksOps
    address (`platformBranding`), with the tenant's name and logo (`resolveEmailBranding`) in the shared
    ChecksOps layout.
  - Recipient: the member who authorized the ACH debit (`tenant_billing_accounts.ach_authorized_by` →
    `identity_accounts.email`), the billing contact who consented to the charge. Fallback is
    `tenants.company_email` (SQL 93). Users-only roles (SQL 90) mean there is no owner role to choose.
  - Contents: tenant name, period, date, booked lines, total, and the last four digits of the account. No
    account, routing or provider ids, and no other personal data.
  - Failure isolation: a failed send or lookup never fails or rolls back the committed charge. It is recorded,
    and the platform owner can resend (`tenant-billing-admin` `invoice-resend`, the SPA's "Resend invoice email"),
    still at most once per charge.

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

## 8. Final review fixes (2026-10-17)

- **Approve lookup fails closed.** `tenant-deposits-gate.mjs` no longer turns a failed
  deposit lookup on `checkalt-approve-deposit` (action `approve`) into "tenant not found".
  A lookup error now refuses with 503 `deposits_status_unavailable`, by deposit id and by
  reference. Only "no rows" still passes to the handler, which refuses an unknown deposit
  itself. Covered by a new test. Re-pinned `tenant-deposits-gate.mjs` in the plan and the
  fee manifest.
- **Staging hold (now enforced by the staging overlay).** Originally an operator rule: the
  staging Lambda overlay had no `sql_before` check. It now has one
  (`scripts/deployment-guard/github-staging-lambda-overlay.mjs`, record
  `ops/deployment-guard/staging-sql-live.json`, where SQL 98 is `verified_live: false`), so
  `providers.mjs`, `workflow-rpc.mjs` and the billing members are refused in staging until SQL
  98 is recorded live there. Do not overlay `providers.mjs` or `workflow-rpc.mjs`
  to staging until SQL 98 is applied in staging. Before that, every staging deposit call
  returns 503 `deposits_status_unavailable`, because `aws_tenant_deposits_enabled` does not
  exist yet. SQL 98 (and SQL 99) still need staging-executor and production apply tooling
  on the SQL 90-97 engine. That is a follow-up PR, and it is required before the staging
  deploy. Production is held by the plan's `sql_before` on SQL 98. (Done in
  claude/sql98-100-apply-tooling, with SQL 100.)

## §9 Production inspect 2026-10-17 and reconciliation

Read-only SQL 98 inspects (SSM `24b9f38c-…`, `f6419152-…`, `2693cdef-…`):
- `platform_billing_destination` already exists in production (created outside the repository;
  its definition matches the Cursor `43_moov_monthly_tenant_billing.sql`) with exactly one row:
  production, on the owner-confirmed platform account `41cb5d67-4911-4bef-aad5-d8ee9c582208`,
  with a payment method, verified (counts only; no id read out). SQL 98 keeps it
  (`platform_billing_destination_absent_empty_or_reviewed`, owner decision 2026-10-17); any
  other row is refused. The payment method is not compared with a reviewed value.
- `record_check_billing_event()` has EXECUTE for PUBLIC, `checksops` and the owner; SQL 98 now
  grants `checksops` as live (owner decision 2026-10-17) and still revokes PUBLIC.
- The take-over shape differed only by PostgreSQL 18's named NOT NULL constraints; the release
  engine now leaves contype `n` out (the column `notnull` carries it).
- Staging (read-live run 39076252693): `platform_billing_destination` holds one verified sandbox
  row with a payment method. Owner decision 2026-10-17 (option A): the staging executor accepts
  exactly that shape (one verified `sandbox` row, a payment method, no `production` row); the
  production tool keeps the reviewed-row rule.
