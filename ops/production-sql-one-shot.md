# Production SQL one-shot

`scripts/deployment-guard/production-sql-one-shot.mjs` runs one production SQL migration
on the SQL53 runner (`i-0c35557c4e5385406`) as **one** invocation. It replaces the
hand-written SSM scripts used for SQL 77–80 (see `ops/production-sql-77-79-apply.md` and
`ops/production-sql-80-apply.md`). It does not weaken any guard. It only orchestrates
the existing per-migration tools as child processes, and those tools stay the only code
that connects to the database:

| `--migration` | tool it runs |
|---|---|
| `sql29` | `scripts/deployment-guard/sql29-mortgage-ops-library-parity-production-apply.mjs` (`ops/production-sql-29-30-apply.md`; before SQL 90 and SQL 94: the tool refuses with `sql90_not_applied` once SQL 90 is in place, and the one-shot also requires the inspect's `sql90_applied` to be `false`) |
| `sql30` | `scripts/deployment-guard/sql30-tenant-documents-doc-type-production-apply.mjs` (same runbook; before SQL 90, a SQL 90 predecessor, and before SQL 94, whose CHECK it refuses; independent of SQL 29, release order runs SQL 29 first) |
| `sql71` | `scripts/deployment-guard/sql71-review-amount-production-apply.mjs` (`ops/production-sql-71-apply.md`) |
| `sql77`, `sql78`, `sql79` | `scripts/deployment-guard/sql-member-stakeholder-production-apply.mjs --migration <key>` |
| `sql80` | `scripts/deployment-guard/sql80-checkalt-production-apply.mjs` |
| `sql81` | `scripts/deployment-guard/sql81-checkalt-production-apply.mjs` (`ops/production-sql-81-apply.md`) |
| `sql82` | `scripts/deployment-guard/sql82-homeowner-ledger-production-apply.mjs` (`ops/production-sql-82-83-apply.md`) |
| `sql83` | `scripts/deployment-guard/sql83-homeowner-signing-production-apply.mjs` (`ops/production-sql-82-83-apply.md`) |
| `sql84` | `scripts/deployment-guard/sql84-mortgage-return-to-queue-production-apply.mjs` (`ops/production-sql-84-86-apply.md`) |
| `sql85` | `scripts/deployment-guard/sql85-mortgage-compensation-adjust-production-apply.mjs` (`ops/production-sql-84-86-apply.md`) |
| `sql86` | `scripts/deployment-guard/sql86-mortgage-compensation-owner-only-production-apply.mjs` (`ops/production-sql-84-86-apply.md`) |
| `sql87` | `scripts/deployment-guard/sql87-resolve-check-case-tenant-scope-production-apply.mjs` (`ops/production-sql-87-apply.md`) |
| `sql88` | `scripts/deployment-guard/sql88-claim-id-assign-case-tenant-scope-production-apply.mjs` (`ops/production-sql-88-apply.md`) |
| `sql89` | `scripts/deployment-guard/sql89-check-intake-column-update-production-apply.mjs` (`ops/production-sql-89-apply.md`) |
| `sql90` … `sql97` | `scripts/deployment-guard/sql90-users-only-tenant-roles-production-apply.mjs`, `sql91-moov-onboarding-…`, `sql92-signature-request-check-files-link-grant-…`, `sql93-tenant-company-info-…`, `sql94-document-library-restore-…`, `sql95-remove-freedom-claims-bridge-…`, `sql96-platform-owner-tenant-pricing-…`, `sql97-financial-stepup-log-server-writer-production-apply.mjs` (`ops/production-sql-90-97-apply.md`, which also gives their order) |
| `sql98` … `sql100` | `scripts/deployment-guard/sql98-tenant-fee-collection-production-apply.mjs`, `sql99-mortgage-desk-completion-messages-…`, `sql100-mortgage-desk-live-access-production-apply.mjs` (same runbook; SQL 100 is a strict no-op on production and its tool never runs the file there, so its pin never becomes executable and the one-shot refuses it) |
| `sql101` | `scripts/deployment-guard/sql101-invite-identity-insert-order-production-apply.mjs` (same runbook; after SQL 90, before `tenant-admin.mjs`) |
| `sql102` | `scripts/deployment-guard/sql102-platform-owner-tenant-profile-production-apply.mjs` (same runbook; after SQL 98, before `tenant-billing-handlers.mjs`) |
| `sql103` | `scripts/deployment-guard/sql103-share-library-trigger-acl-production-apply.mjs` (`ops/production-sql-103-apply.md`; immediately before SQL 29, `runs_before: ['sql29']`: SQL 29's guard refuses the trigger function's live `checksops` EXECUTE until SQL 103 ran; no predecessor, already in place after SQL 29) |
| `sql104` | `scripts/deployment-guard/sql104-payment-idempotency-keys-grant-production-apply.mjs` (`ops/production-sql-104-apply.md`; any time after SQL 91: the `payment_idempotency_keys` table grant SQL 91 omitted, #1062) |
| `sql105` | `scripts/deployment-guard/sql105-onboarding-payment-table-grants-production-apply.mjs` (`ops/production-sql-105-apply.md`; any time after SQL 91: the table grants SQL 91 omitted on `payment_provider_accounts`, `payment_provider_methods`, `payment_method_verifications` and `payment_event_log`) |
| `sql106` | `scripts/deployment-guard/sql106-financial-stepup-log-append-only-production-apply.mjs` (`ops/production-sql-106-apply.md`; before SQL 97, `runs_before: ['sql97']`: SQL 97's runbook stops its apply unless its inspect's `other_write_grants` is `[]`, which SQL 106 makes it; no predecessor) |
| `sql108` | `scripts/deployment-guard/sql108-check-intake-items-funds-type-values-production-apply.mjs` (`ops/production-sql-108-apply.md`; `check_intake_items_funds_type_check` with the nine SPA funds_type values; no predecessor, no order) |
| `sql109` | `scripts/deployment-guard/sql109-moov-transfer-webhook-status-production-apply.mjs` (`ops/production-sql-109-apply.md`; any time after SQL 91: the SECURITY DEFINER Moov transfer webhook writer, status / ACH return / NOC of a funding or send leg) |
| `sql110` | `scripts/deployment-guard/sql110-homeowner-preclaim-links-production-apply.mjs` (`ops/production-sql-110-apply.md`; DELETE on `homeowner_ledger_tokens` for `checksops` and the SECURITY DEFINER public homeowner upload writer; no predecessor, no order) |
| `sql111` | `scripts/deployment-guard/sql111-tenant-referral-codes-production-apply.mjs` (`ops/production-sql-111-apply.md`; the five SECURITY DEFINER tenant referral code functions; no predecessor, no order) |
| `sql112` | `scripts/deployment-guard/sql112-moov-invoice-table-grants-production-apply.mjs` (`ops/production-sql-112-apply.md`; the table grants of `checksops` and `authenticated` on `moov_invoices` and `moov_invoice_customers`; no predecessor, no order) |
| `sql113` | `scripts/deployment-guard/sql113-payee-setup-production-apply.mjs` (`ops/production-sql-113-apply.md`; the payee state columns on `external_payment_recipients`, origin `provider_recipient`, SELECT on `external_payment_recipients` for `checksops` and `authenticated`, and the six SECURITY DEFINER payee functions; no predecessor, no order) |
| `sql114` | `scripts/deployment-guard/sql114-stakeholder-settings-update-grant-production-apply.mjs` (`ops/production-sql-114-apply.md`; UPDATE on `stakeholder_accounts` `is_active`, `is_primary`, `account_type`, `homeowner_name`, `homeowner_email` and `updated_at` for `checksops` and `authenticated`, column-scoped; no predecessor, no order) |
| `sql115` | `scripts/deployment-guard/sql115-provider-stakeholder-one-partner-payout-production-apply.mjs` (`ops/production-sql-115-apply.md`; `sync_provider_stakeholder_account(uuid)` keeps one active partner payout per tenant, EXECUTE owner only; no predecessor, no order) |
| `sql116` | `scripts/deployment-guard/sql116-moov-onboarding-profile-industry-production-apply.mjs` (`ops/production-sql-116-apply.md`; `moov_onboarding_profiles.industry text`, nullable, no default; after SQL 91, which it supersedes) |
| `sql117` | `scripts/deployment-guard/sql117-platform-owner-tenant-lifecycle-production-apply.mjs` (`ops/production-sql-117-apply.md`; `tenant_deactivations` and the platform-owner deactivate, reactivate, activity, delete-empty and deactivated-list functions; no predecessor; retired, never applied: SQL 118 replaces it) |
| `sql118` | `scripts/deployment-guard/sql118-platform-owner-tenant-lifecycle-production-apply.mjs` (`ops/production-sql-118-apply.md`; SQL 117 plus every non-owner grant on `tenant_deactivations` revoked: the table and the platform-owner deactivate, reactivate, activity, delete-empty and deactivated-list functions; no predecessor; supersedes the retired SQL 117) |
| `sql119` | `scripts/deployment-guard/sql119-provider-stakeholder-sync-acl-production-apply.mjs` (`ops/production-sql-119-apply.md`; EXECUTE on `sync_provider_stakeholder_account(uuid)` for its owner only (`PUBLIC`, `checksops` and, where they exist, `anon`, `authenticated` and `service_role` revoked); no predecessor; `runs_before` `sql115`) |
| `sql120` | `scripts/deployment-guard/sql120-usage-events-at-approval-and-send-production-apply.mjs` (`ops/production-sql-120-apply.md`; usage events at Check Alt approval and at send time: two triggers, five owner-only functions, the one-fee-per-leg unique index and a backfill from 2026-10-01; no predecessor) |
| `sql121` | `scripts/deployment-guard/sql121-cash-jobs-grants-production-apply.mjs` (`ops/production-sql-121-apply.md`; SELECT, INSERT, UPDATE, DELETE on `cash_jobs`, `cash_job_line_items` and `cash_job_attachments` for `checksops` and `authenticated`, `sync_cash_job_check_payment()` SECURITY DEFINER and owner-only, and the cash-job payment at Check Alt approval: one owner-only function and its trigger on `checkalt_deposits`; no predecessor) |
| `sql122` | `scripts/deployment-guard/sql122-mortgage-desk-return-to-tenant-production-apply.mjs` (`ops/production-sql-122-apply.md`; the Mortgage Desk returns its work to the tenant: `mortgage_handling_requests.return_emailed_at` and six SECURITY DEFINER functions, five with EXECUTE for `checksops` (Desk message, Desk document, shipping details, homeowner timeline row, "work returned" email claim) and the owner-only working-request check; no policy, table grant or trigger; no predecessor) |
| `sql123` | `scripts/deployment-guard/sql123-checkalt-deposit-check-status-production-apply.mjs` (`ops/production-sql-123-apply.md`; a Check Alt deposit approved or accepted moves its check to Deposited, rejected, error, duplicate or returned after approval moves it to Returned: two owner-only SECURITY DEFINER functions and one trigger on `checkalt_deposits` that fires before SQL 120's and SQL 121's, and a one-time move of checks already approved and billed; no predecessor) |
| `sql124` | `scripts/deployment-guard/sql124-mortgage-desk-signature-and-reads-production-apply.mjs` (`ops/production-sql-124-apply.md`; the Mortgage Desk sends a check's document for signature, reads the check's thread, files and signature requests, and posts homeowner timeline updates: eight SECURITY DEFINER functions, seven with EXECUTE for `checksops` (messages, check files, signature requests, the storage-read path check, the signature request create, its delivery record, the timeline row) and the owner-only readable-request check; no table, column, policy, table grant or trigger; no predecessor) |
| `sql125` | `scripts/deployment-guard/sql125-deposit-views-security-invoker-production-apply.mjs` (`ops/production-sql-125-apply.md`; security_invoker on the four Supabase-era deposit views `deposit_queue_scored`, `deposit_owner_performance`, `deposit_reminder_queue` and `deposit_aging_dashboard`: no definition, grant or function change) |
| `sql126` | `scripts/deployment-guard/sql126-definer-reads-caller-gates-production-apply.mjs` (`ops/production-sql-126-apply.md`; the thirteen Supabase-era SECURITY DEFINER reads check their caller themselves: owner-only, tenant, check and self gates, `get_stuck_checks` and `get_check_unread_counts` scoped to the caller; same signatures, EXECUTE for `checksops` and the owner) |
| `sql127` | `scripts/deployment-guard/sql127-homeowner-portal-signing-production-apply.mjs` (`ops/production-sql-127-apply.md`; homeowners sign their checks and documents from the claim portal: SQL 83's `aws_public_homeowner_ledger_endorse_capability` opens `pending` as well as `sent` insured endorsements, `aws_public_homeowner_pending_signatures` lists an open homeowner signer whose emailed link expired, and the new `aws_public_homeowner_document_portal_signer` returns the signer's existing token hash and renews its expiry; three SECURITY DEFINER functions, EXECUTE for `checksops` and the owner; no table, column, policy, table grant or trigger; no predecessor) |
| `sql128` | `scripts/deployment-guard/sql128-contractor-verification-from-compliance-production-apply.mjs` (`ops/production-sql-128-apply.md`; contractor verification reads the Compliance & Docs uploads: `contractor_verification_status` takes the W-9 and insurance from the contractor's tenants' `moov_compliance_documents` and `tenant_documents` instead of the dropped `contractor_documents`; EXECUTE for `checksops` and the owner; the orphan `_trg_recompute_contractor_tier_from_docs()` dropped) |
| `sql129` | `scripts/deployment-guard/sql129-financial-totp-rate-limit-code-check-production-apply.mjs` (`ops/production-sql-129-apply.md`; the financial TOTP rate limit accepts `code_check`, the action the API sends for every authenticator-code check since finding 7: `consume_financial_totp_rate_limit` keeps its body except the action allow-list; no grant change; retired, never applied: SQL 130 replaces it) |
| `sql130` | `scripts/deployment-guard/sql130-financial-totp-rate-limit-code-check-no-public-production-apply.mjs` (`ops/production-sql-130-apply.md`; SQL 129's `code_check` allow-list plus EXECUTE revoked from `PUBLIC` and granted to `checksops` on `consume_financial_totp_rate_limit` only: production (PUBLIC granted) and staging (no PUBLIC) reach the same state; supersedes SQL 129) |
| `sql131` | `scripts/deployment-guard/sql131-financial-totp-functions-no-public-production-apply.mjs` (`ops/production-sql-131-apply.md`; EXECUTE revoked from `PUBLIC` and granted to `checksops` on the four financial TOTP enrollment functions `financial_totp_upsert_enrollment`, `_get_enrollment`, `_mark_verified` and `_status`, which the API calls as `checksops`; bodies, owners and the fifth function (SQL 130) unchanged; predecessor `sql130`) |
| `sql132` | `scripts/deployment-guard/sql132-financial-totp-code-check-lockout-production-apply.mjs` (`ops/production-sql-132-apply.md`; the financial TOTP lockout: the new SECURITY DEFINER `financial_totp_count_code_check(uuid)` counts a code check before the API compares the code, locks the enrollment for 15 minutes at the tenth consecutive check without a success and refuses while locked; `financial_totp_mark_verified` clears both on a correct code; EXECUTE for `checksops` and the owner; predecessor SQL 130) |
| `sql133` | `scripts/deployment-guard/sql133-financial-totp-admin-reset-enrollment-production-apply.mjs` (`ops/production-sql-133-apply.md`; the teammate reset of a financial TOTP enrollment: the new SECURITY DEFINER `financial_totp_admin_reset_enrollment(uuid, uuid)` re-checks the API's gate in the database (the caller is `auth.uid()`, not the target, shares a tenant with the target, the target is not the platform owner) and deletes the target's `financial_totp_enrollments` row, `cleared false` when there is none; EXECUTE for `checksops` and the owner; no predecessor) |
| `sql134` | `scripts/deployment-guard/sql134-loss-draft-escrow-write-grants-production-apply.mjs` (`ops/production-sql-134-apply.md`; the Loss Draft escrow and draw records: column UPDATE (`total_escrowed`, `draw_amount_requested`, `draw_stage`, `draw_amount_released`, `holdback_amount`) on `loss_draft_tracking` and column INSERT (`loss_draft_id`, `draw_number`, `amount_requested`, `amount_released`, `release_date`, `released_at`, `status`, `notes`, `created_by`) on `loss_draft_releases`, for `checksops` and `authenticated`; no predecessor, no policy change) |

To add a migration, register its reviewed tool in `ONE_SHOT_TOOLS`
(`scripts/deployment-guard/lib/production-sql-one-shot.mjs`). An entry names only the tool,
its arguments, the pin file and the tool's `<key>_production_apply_allowed`; the file hash
(`source_sha256`) and the fingerprints are always read from the pin, so a reviewed change to
a migration file touches its pin, not the registry. An entry may add `inspect_requires`
(inspect fields that must hold an exact value, e.g. SQL 29's `sql90_applied: false`) and
`runs_before` (informational order). Tests:
`aws/tests/production-sql-one-shot.test.mjs` (in `npm run test:deployment-guard`).

## Flags

| flag | |
|---|---|
| `--migration <key>` | a registered key (`sql29`, `sql30`, `sql71`, `sql77`…`sql89`, `sql90`…`sql106`, `sql108`, `sql109`, `sql110`, `sql111`, `sql112`, `sql113`, `sql114`, `sql115`, `sql116`, `sql117`, `sql118`, `sql119`, `sql120`, `sql121`, `sql122`, `sql123`, `sql124`, `sql125`, `sql126`, `sql127`, `sql128`, `sql129`, `sql130`, `sql131`, `sql132`, `sql133`, `sql134`) |
| `--approval-scope <key>` | the migration the owner approved; must equal `--migration` |
| `--approval-statement "<words>"` or `--approval-statement-b64 <base64>` | the owner's exact words, recorded verbatim. Pass exactly one of the two. Use the base64 form when the words contain quotes or newlines. Must be non-empty. |
| `--commit <sha>` | the full main commit the tarball was built from |
| `--workstream-id <id>` | this workstream (`^[A-Za-z0-9._:-]{8,128}$`) |
| `--operator <login>` | required; recorded in the manifest |
| `--source-tarball <path>` | the downloaded `source-<sha>.tar.gz`, with its `.sha256` next to it |
| `--expected-tarball-sha256 <hex>` | the `TARBALL_SHA256` line printed in the transfer run's log |
| `--phase inspect\|apply` | |
| `--runner <label>` | optional, e.g. the instance id; defaults to the hostname. Either way the source is recorded in `runner_basis`. |

Every other flag is refused, including `--receipt`, `--input` and `--skip-contracts`. The
one-shot never takes a receipt, a manifest or an input file, and it never writes a
receipt itself.

It also refuses to start in any of these cases:

- any `CHECKSOPS_DEPLOYMENT_GUARD_*` variable, or `CHECKSOPS_SKIP_DEPLOYMENT_GUARD`, is
  set. There is no exception: the KMS variables are read only by the GitHub-hosted
  Lambda, SPA and staging-executor scripts, and never by `preflight.mjs` or these tools.
- a node loader variable is set (`NODE_OPTIONS`, `NODE_PATH`, `NODE_REPL_EXTERNAL_MODULE`,
  `NODE_PRESERVE_SYMLINKS*`, `NODE_ICU_DATA`, `NODE_COMPILE_CACHE`, `OPENSSL_CONF`,
  `OPENSSL_MODULES`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `LD_AUDIT`, `DYLD_*`).
- node itself was started with flags.

Children get only `PATH`, `HOME`, `USER`, `LANG`, `LC_ALL`, `TZ`, `AWS_REGION`,
`AWS_DEFAULT_REGION` and `AWS_ENDPOINT_URL_SECRETS_MANAGER`. The tools read the admin
secret with the instance role in `us-east-1` and connect with the repository's RDS CA
bundle, so they need nothing else.

## What one run does

Each step must pass before the next one starts. The run prints one JSON summary and
exits 1 at the first failure (`details.stopped_at` names the step).

An unexpected exception also ends in one failure summary:
- `code` is `ONE_SHOT_EXCEPTION`;
- `stopped_at` is `<last completed step> (exception)`;
- the steps completed so far are listed;
- if the apply child had started, a `warning` says to run the read-only `--inspect`
  before anything else.

1. **Pin.** Refuses unless the pin has `execute: true`, a staging acceptance
   (`ok: true` plus a reference) and an authorization phrase. SQL 132's pin is `execute: true`
   (owner-approved pin change of 2026-10-30: the read-only production inspect of 2026-10-30, SSM
   `ea2ce576-471a-4a90-bb50-e52b3430e6ec`, recorded as its pre-state, on its guarded staging apply
   run 41117004966; see `ops/production-sql-132-apply.md`) until its record-and-retire change; the
   production apply still needs the owner's words for that run. SQL 131's pin is `execute: false`
   again since its 2026-10-30 apply (owner statement "apply SQL 131 in production"; see
   `ops/production-sql-131-apply.md`). SQL 130's pin is `execute: false`
   again since its 2026-10-30 apply (owner statement "apply SQL 130 in production"; see
   `ops/production-sql-130-apply.md`). SQL 128's pin is `execute: false`
   again since its 2026-10-30 apply (owner statement "apply SQL 128 in production"; see
   `ops/production-sql-128-apply.md`). SQL 127's pin is `execute: false`
   again since its 2026-10-29 apply (owner statement "apply SQL 127 into production"; see
   `ops/production-sql-127-apply.md`). SQL 126's pin is `execute: false`
   again since its 2026-10-29 apply (owner statement "apply SQL 126 in production"; see
   `ops/production-sql-126-apply.md`). SQL 125's pin is `execute: false`
   again since its 2026-10-29 apply (owner statement "apply SQL 125 in production after 1382 merges"; see
   `ops/production-sql-125-apply.md`). SQL 124's pin is `execute: false`
   again since its 2026-10-28 apply (owner statement "apply SQL 124 into production"; see
   `ops/production-sql-124-apply.md`). SQL 123's pin is `execute: false`
   again since its 2026-10-28 apply (owner statement "merge 1335 when green and apply SQL 123 into production"; see
   `ops/production-sql-123-apply.md`). SQL 122's pin is `execute: false`
   again since its 2026-10-28 apply (owner statement "then apply SQL 122 in production"; see
   `ops/production-sql-122-apply.md`). SQL 121's pin is `execute: false`
   again since its 2026-10-27 apply (owner statement "then apply SQL 121 in production"; see
   `ops/production-sql-121-apply.md`). SQL 120's pin is `execute: false`
   again since its 2026-10-27 apply (owner statement "Approve bundle prod-sql120-usage-events-20261027. Apply SQL 120 in production. DEPLOY WEBSITE TO PRODUCTION", bundle
   `prod-sql120-usage-events-20261027`; see `ops/production-sql-120-apply.md`). SQL 115's pin is `execute: false`
   again since its 2026-10-27 apply after SQL 119's (owner statement "AWS reconnected, apply SQL 115 in
   production"; see `ops/production-sql-115-apply.md`). SQL 119's pin is `execute: false`
   again since its 2026-10-27 apply (owner statement "Apply in production: SQL 119 first, then SQL
   115"; see `ops/production-sql-119-apply.md`). SQL 118's pin is `execute: false`
   again since its 2026-10-27 apply (owner statement "Apply SQL 118 in production"; see
   `ops/production-sql-118-apply.md`). SQL 116's pin is `execute: false`
   again since its 2026-10-26 apply (owner statement "apply SQL 116 in production"; see
   `ops/production-sql-116-apply.md`). SQL 114's pin is `execute: false`
   again since its 2026-10-25 apply (owner statement "approve SQL 114 production apply"; see
   `ops/production-sql-114-apply.md`). SQL 113's pin is `execute: false`
   again since its 2026-10-23 apply (owner statement "apply SQL 113 in production and merge 1209
   when green"; see `ops/production-sql-113-apply.md`). SQL 112's pin is `execute: false`
   again since its 2026-10-23 apply (owner statement "apply SQL 112 in production"; see
   `ops/production-sql-112-apply.md`). SQL 111's pin is `execute: false`
   again since its 2026-10-23 apply (owner statement "apply SQL 111 in production"; see
   `ops/production-sql-111-apply.md`). SQL 110's pin is `execute: false`
   again since its 2026-10-22 apply (owner statement "apply SQL 110 in production"; see
   `ops/production-sql-110-apply.md`). SQL 109's pin is `execute: false`
   again since its 2026-10-21 apply (owner statement "apply SQL 109 in production"; see
   `ops/production-sql-109-apply.md`). SQL 108's pin is `execute: false`
   again since its 2026-10-21 apply (owner statement "apply SQL 108 in production"; see
   `ops/production-sql-108-apply.md`). SQL 106's and SQL 97's pins are
   `execute: false` again since their 2026-10-21 applies (SQL 106 first, then SQL 97, one owner
   statement "apply SQL 106 and SQL 97 in production"; see `ops/production-sql-106-apply.md` and
   `ops/production-sql-90-97-apply.md`). SQL 95's and SQL 99's pins are `execute: false`
   again since their 2026-10-21 applies (see `ops/production-sql-90-97-apply.md`). SQL 82's to 86's pins are `execute: false` again since their 2026-10-21 record-and-retire
   change (`applied` result `verified_live`: production state verified by read-only inspects,
   see `ops/production-sql-82-83-apply.md` and `ops/production-sql-84-86-apply.md`). SQL 91's, SQL 92's, SQL 90's, SQL 101's, SQL 93's, SQL 96's, SQL 94's,
   SQL 104's and SQL 98's are `execute: false`
   again since their 2026-10-19 applies, and SQL 102's and SQL 105's since their 2026-10-20 applies (see
   `ops/production-sql-90-97-apply.md` and `ops/production-sql-105-apply.md`). Every other pin is `execute: false` (SQL 81's since its
   2026-10-15 record-and-retire change; SQL 87's, SQL 88's and SQL 89's since their
   2026-10-16 applies, see `ops/production-sql-87-apply.md`, `ops/production-sql-88-apply.md`
   and `ops/production-sql-89-apply.md`; SQL 103's, SQL 29's and SQL 30's since their
   2026-10-19 applies, see `ops/production-sql-103-apply.md` and `ops/production-sql-29-30-apply.md`;
   SQL 71's still pending), so a run of it refuses until an owner-merged
   change sets it to true. For a read-only inspect before that change, run the tool's own `--inspect`.
2. **Source.** All of these must hold:
   - The tarball's name is `source-<--commit>.tar.gz`.
   - The tarball is read into memory once. Its sha256 must equal both the `.sha256`
     sidecar and `--expected-tarball-sha256`, and the file index is built from those same
     bytes.
   - `SOURCE_COMMIT` in the tree is `--commit`. Tarballs built before that file existed
     must be staged again.
   - Every file of the running tree is byte-identical to the tarball, with the same
     symlinks and no extra files (`.deployment-guard/` is ignored).
   - No symlink resolves outside the tree, checked both lexically and with the kernel's
     realpath. For example, `s -> .` plus `t -> s/..` is refused, and so is a dangling
     link.
   - The migration file's sha256 equals the pin's `source_sha256`.

   The tree comparison is repeated right before preflight and right before apply. Each
   repeat compares against that cached index; the tarball file on disk is not read
   again, so swapping the tarball and the tree together is caught.
3. **Inspect (read-only).** Runs `<tool> --inspect`. It stops unless all of these hold:
   - `read_only`, `source_ok` and `pin_execute` are true, and there is no `state_error`;
   - no dependencies are missing, and the predecessors are applied;
   - the live hash equals the pin's expected hash, and `live_matches_expected` is true;
   - `already_applied` is false;
   - `precondition_failures` is `[]` and `apply_preconditions_met` is true;
   - every `inspect_requires` field of the registry entry holds its value (SQL 29:
     `sql90_applied` is `false`).
4. **Contracts.** The one-shot runs, on this tree, the test of every accepted contract in
   `ops/deployment-guard/accepted-contracts.json` that applies to a production
   `sql-apply`. Today that is `claim-ledger`, `tenant-isolation` and
   `financial-write-protections` (`aws/tests/api-write.test.mjs`).
   - Each test runs as `node --test --test-reporter=tap`. The counts come from the
     reporter's final summary.
   - The run stops unless every test passes, with none failed, cancelled, skipped or todo.
   - Each recorded result names the runner and how that runner was identified.
   - Preflight does not run tests itself. It only refuses a `sql-apply` manifest that
     lacks a passing result for each of these contracts. These are the results it reads.
   - **`--phase inspect` ends here and writes nothing.**
5. **Manifest.** Written to a fresh `0600` file in a temp directory outside the tree.
   The directory is deleted when the run ends, whether it succeeded or failed; the summary
   keeps `manifest_sha256`. The manifest holds:
   - the pin's file, ids, hashes, staging acceptance and phrase;
   - the inspect's live hash as all three fingerprints;
   - `approval`: `{ approved: true, workstream_id, approved_by: "owner", statement }`;
   - a new `one_use_id` (`<key>-prod-<uuid>`), `build_timestamp` and the contract
     results.
6. **Preflight.** Runs `preflight.mjs --acquire-lease --receipt --input <manifest>`. The
   receipt path comes only from this child's output, and it must sit under
   `.deployment-guard/receipts/`.
7. **Evaluate.** Runs `<tool> --input <manifest>`, which must report
   `member_stakeholder_production_apply_allowed` / `sql71_production_apply_allowed` /
   `sql80_production_apply_allowed` /
   `sql81_production_apply_allowed` / `sql82_production_apply_allowed` /
   `sql83_production_apply_allowed` / `sql84_production_apply_allowed` /
   `sql85_production_apply_allowed` / `sql86_production_apply_allowed` /
   `sql87_production_apply_allowed` / `sql88_production_apply_allowed` /
   `sql89_production_apply_allowed` / `sql29_production_apply_allowed` /
   `sql30_production_apply_allowed` / `sql90_production_apply_allowed` … true (the
   registry entry's `allowed_key`).
8. **Apply.** Runs `<tool> --apply --input <manifest>`.
   - This is the only child that gets `CHECKSOPS_DEPLOYMENT_GUARD_APPLY=1` and
     `CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT`.
   - The tool's own checks still decide: guard, receipt ownership, execute, phrase,
     `one_use_id`, and the re-read inside the transaction.
   - The apply must report `applied` with the pin's before and after hashes.
9. **Post-apply inspect.** It must show the intended hash and `already_applied` true.
   It also runs after a failed apply, because the COMMIT outcome can be unknown.

On success, `details.applied` is a ready-to-paste block for the pin's `applied` record.
It contains only what this run observed. Items the run cannot observe are marked:

- `one_use_id_consumed_basis`: inferred from the successful apply.
- `runner_basis`: the runner label came from `--runner` or from the hostname.
- `owner_approval_basis`: the statement and scope as passed.
- `source_commit_basis`: `SOURCE_COMMIT` and the operator-copied tarball sha256.

`details.not_observed_by_this_run` lists what the operator adds from outside: the SSM
command id and the `sql53-temporary-transfer` run id.

**Replay protection.** A second run cannot apply the same migration twice:

- the tool's inspect and its in-transaction re-read refuse a live state that is already
  the intended one (`already_applied`);
- the record-and-retire change sets the pin's `execute` back to `false`, and step 1 then
  refuses every run.

`one_use_id` does not provide this. Every run mints a fresh id, and the tool's consumed-id
registry lives in the extracted tree's `.deployment-guard/`, which is new for every
extraction.

## The transfer workflow

`.github/workflows/sql53-temporary-transfer.yml` has three jobs:

- `package` (contents read). Archives main, adds the runner dependencies (root `pg` and
  `@aws-sdk/client-secrets-manager`, plus `aws/functions/api`'s own lockfile
  dependencies, so `api-write.test.mjs` loads), writes `SOURCE_COMMIT`, tars and
  hashes, and prints `TARBALL_SHA256 <hex>`. It runs no tests.
- `contracts` (contents read, no AWS token). Re-verifies the handed-off tarball's sha256
  against the `package` job's output, extracts it into a fresh directory, and runs the
  contracts the registry requires for a production `sql-apply`. The list is built with
  command substitution, so a failing node exits the step, and an empty list fails the
  job.
- `upload` (the only job with `id-token: write`). Runs no repository or npm code. It
  re-verifies the tarball and its sidecar against the `package` job's sha256 output,
  then uploads both.

## Runner state: stopped between runs

The runner's instance role (`ChecksOpsSql53TemporaryRunner`) reads the production
`checksops_admin` secret, so the instance stays **stopped** whenever no production inspect or
apply is in progress (security audit finding C, 2026-10-29). Start it for a run and stop it
again when the run is done; the transfer workflow does not need it.

Before the inspect or apply (an administrator, `ec2:StartInstances` on the instance):

```bash
aws ec2 start-instances --instance-ids i-0c35557c4e5385406
aws ec2 wait instance-running --instance-ids i-0c35557c4e5385406
# SSM must report the runner Online before the single SSM command below.
aws ssm describe-instance-information \
  --filters Key=InstanceIds,Values=i-0c35557c4e5385406 \
  --query 'InstanceInformationList[0].PingStatus' --output text
```

After the last command of the run (inspect, apply and post-apply inspect), and before the
record PR:

```bash
aws ec2 stop-instances --instance-ids i-0c35557c4e5385406
aws ec2 wait instance-stopped --instance-ids i-0c35557c4e5385406
```

The record PR notes the start and stop times. A runner found running with no run in
progress is stopped and reported to the owner.

First stop (2026-10-29), owner approval verbatim: "merge 1374 when green and stop the SQL
runner". Precondition: the instance was `running`, named `checksops-sql53-temporary-runner`
with instance profile `ChecksOpsSql53TemporaryRunner`, and no SSM command was pending or in
progress. `ec2:StopInstances` at 2026-10-29 13:18:29 UTC by `user/claude-code`; `stopped` at
13:18:52 UTC (`StateTransitionReason`: "User initiated (2026-10-29 13:18:30 GMT)"). The last
run before it was SQL 124's post-apply inspect, 2026-10-28 20:16 UTC.

## The single SSM command

Stage the reviewed main commit with the transfer workflow first, and copy the
`TARBALL_SHA256` value from its log.

```bash
set -euo pipefail
SHA=<full main sha>
TARBALL_SHA256=<TARBALL_SHA256 from the transfer run log>
WORK=$(mktemp -d /var/tmp/sql-one-shot-XXXXXX)
cd "$WORK"
aws s3 cp "s3://checksops-sql53-transfer-806168576068/sql53/source-${SHA}.tar.gz" . --no-progress
aws s3 cp "s3://checksops-sql53-transfer-806168576068/sql53/source-${SHA}.tar.gz.sha256" . --no-progress
echo "${TARBALL_SHA256}  source-${SHA}.tar.gz" | sha256sum -c -
mkdir src
tar -xzf "source-${SHA}.tar.gz" -C src
cd src
export AWS_ENDPOINT_URL_SECRETS_MANAGER=https://vpce-01649ea2cdb21a689-tp7fo1qj.secretsmanager.us-east-1.vpce.amazonaws.com
node scripts/deployment-guard/production-sql-one-shot.mjs \
  --migration sql80 \
  --approval-scope sql80 \
  --commit "$SHA" \
  --workstream-id prod-sql80-<name>-<yyyymmdd> \
  --operator michaelcarletta-cmd \
  --approval-statement-b64 '<base64 of the owner'"'"'s exact words>' \
  --source-tarball "$WORK/source-${SHA}.tar.gz" \
  --expected-tarball-sha256 "$TARBALL_SHA256" \
  --runner i-0c35557c4e5385406 \
  --phase inspect          # then, for the approved run, the same command with --phase apply
```

Extract into a fresh, empty directory, because an extra file in the tree stops the run.
`--phase inspect` may come first and needs no apply approval, since it is read-only.
`--phase apply` runs only after the owner has approved that named run, and it repeats
every check. Afterwards, a reviewed change records `details.applied` in the pin and sets
`execute` back to `false`, as for SQL 77–80.

## Approval bundles

This is the owner's working agreement for running a workstream end to end without a
round trip at every step.

1. **Before work starts, the operator lists the bundle:**
   - the files to change, with the hashes they will have (SQL `source_sha256`, pinned
     expected and intended hashes);
   - the lock and plan changes (pin fields, release-lock or ledger entries);
   - the ordered staging and production steps, each with its exact command. For
     production SQL: the transfer run, this one-shot's `--phase inspect`, the named
     `--phase apply` run (migration key, workstream id, commit), and the
     record-and-retire change.
2. **The owner approves that named list once, for this workstream.** The approval names
   the workstream id and the production runs it covers. For each production apply, the
   operator passes the owner's exact words as `--approval-statement` (or `-b64`), and that
   run's migration key as `--approval-scope`.
3. **The `execute: true` pin change is never part of what the operator self-approves.**
   It is its own reviewed PR, which the owner reviews and merges. The bundle may list it
   as a step, but the operator only opens it and then waits for the owner's merge. Until
   that merge is on main and staged by the transfer workflow, step 1 of the one-shot
   refuses. A read-only `--phase inspect` may run before the apply approval; the apply
   itself runs only for a run the owner named.
4. **The operator runs the list end to end, and stops and returns to the owner on any
   of these:**
   - a hash that differs from the list (source, tarball, live pre-state, after-state);
   - a guard refusal: `DEPLOYMENT_COLLISION`, `SOURCE_RECONCILIATION_REQUIRED`,
     `SOURCE_COMPOSITION_REQUIRED`, or any other refusal code;
   - a failed check, contract or inspect condition;
   - anything that is not on the list, including a new step, a changed command or a
     different target.

   A stop is never worked around, retried with different inputs, or "fixed forward"
   without returning to the owner.

This agreement **does not change the rules in `AGENTS.md`**:

- Production still requires explicit owner approval for **this** workstream plus the
  pin's staging acceptance reference.
- An approval never carries over from an earlier workstream or bundle.
- Receipts come only from `preflight.mjs`; hand-written receipt JSON is `RECEIPT_FORGED`.
- No environment variable bypasses the guard.
- A pin with `execute: false` still refuses.
