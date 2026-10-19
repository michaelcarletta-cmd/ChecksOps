# Production SQL 90 to SQL 102 (release 2026-10-17)

Guarded apply tooling for the thirteen release 2026-10-17 migrations in `aws/workflows/sql/`:
SQL 90 to SQL 97, SQL 98 (tenant fee collection and the deposits switch), SQL 99 / SQL 100
(Mortgage Desk), SQL 101 (the invite's identity-first insert, a fix to SQL 90) and SQL 102 (the
platform owner's tenant profile and member removal). This runbook
covers staging and production and the order between them. It authorizes nothing itself. SQL 91 and SQL 92 were applied to production on 2026-10-19 (see
"Production applies of SQL 91 and SQL 92" below) and their pins are retired (`execute: false`
again, the apply recorded in `applied`); they had been execute-authorized by the owner-approved
pin change of 2026-10-19 (the read-only production inspect, SSM
`433d5e4e-51ec-4d82-8220-87ac9f04d8d7` from main `f51863bbd`, recorded as their pre-state; SQL
91's staging acceptance its guarded staging apply run `39080306273` from the same pre-state,
SQL 92's the owner-accepted substitute staging read-live run `39075498539`). SQL 103's pin is
retired after its apply. SQL 90's production pin is `execute: true` (owner approved 2026-10-19:
the read-only production inspect of 2026-10-19 after SQL 29 / SQL 30, SSM
`9e68e829-7ca0-4499-89ad-8cd691e3cdb8` from main `45d6dbebd`, live `b5a1998d…`, recorded as its
pre-state; its staging acceptance is the owner-accepted substitute evidence of the guarded
staging apply run `39080157856`, which started from a different pre-state `1af4b3ac…`); its
apply still needs the owner's run-time approval, and should be timed with SQL 101 and the
step-6 Lambdas because invites break between SQL 90 and the new `tenant-admin.mjs`. SQL 90 was
applied to production on 2026-10-19 (owner approval "apply SQL 90 in production"; SSM
`216d9a7e-8d5a-4c44-9d2f-e68370cc773a`, run_id `8a427f65-58bc-4a1b-8aac-f5161017df60`,
`b5a1998d…` -> `1351f1d5…`; recorded in its pin by the record-and-retire change). SQL 101's
production pin is `execute: true` (owner approved 2026-10-19 on the agreed SQL 90 -> SQL 101 ->
step-6 Lambdas plan: the read-only inspect right after SQL 90's apply, same SSM command, live
`1c7e1d52…`, precondition_failures [], recorded as its pre-state; its staging acceptance is its
guarded staging apply run `39143679543` from the same pre-state); its apply still needs the
owner's run-time approval and must come before the `tenant-admin.mjs` production overlay. Every other
production pin is `execute: false`, `authorization: "pending"`, with no recorded pre-state and
no staging acceptance, so its production apply refuses before connecting; staging pins are authorized only in reviewed waves ("Staging apply waves"). SQL 100
is a strict no-op on production: its production tool only inspects (see "SQL 100 on
production").

SQL 103 (`aws/workflows/sql/103_share_library_trigger_acl.sql`: EXECUTE on SQL 29's trigger
function for its owner only) uses the same engine and tools but runs first, immediately
before SQL 29: production order SQL 103 → SQL 29 → SQL 30 → SQL 90 → … → SQL 102
(`ops/production-sql-103-apply.md`). SQL 103 was applied to production on 2026-10-19 and its
pin records the apply and is `execute: false` again.

| key | file (sha256) | what it does | predecessors |
|---|---|---|---|
| `sql90` | `90_users_only_tenant_roles.sql` (`488b2ec4…`) | Users only, no tenant role tiers: `aws_is_tenant_member(uuid)` and the membership-rule helpers; `aws_can_write_tenant/check/claim`, tax-profile access, the SQL 35 manager helper and view, SQL 29's `aws_can_manage_mortgage_library` and SQL 80's Auto-Deposit save replaced; members-only write policies; platform-owner-only tenant create, first invite (`aws_first_invite_allowed`, `aws_invite_create_user_identity`) and `user_roles` writes. | SQL 29, SQL 30 |
| `sql91` | `91_moov_onboarding.sql` (`199bfa1a…`) | Four tenant-scoped Moov onboarding tables with RLS, their writer helpers and policies, onboarding / webhook policies on the payment tables, `payment_provider_methods.routing_last_four`. | — |
| `sql92` | `92_signature_request_check_files_link_grant.sql` (`ceef6482…`) | `UPDATE (signature_request_id)` on `check_files` for `checksops` and `authenticated`. | — |
| `sql93` | `93_tenant_company_info.sql` (`d90ec7f9…`) | `company_address`, `company_phone`, `company_email`, `letterhead_url` on `tenants`; the `aws_tenants_member_column_guard` BEFORE UPDATE trigger; drops the draft `aws_member_update_tenant_branding` policy. | SQL 90 |
| `sql94` | `94_document_library_restore.sql` (`ef865f65…`) | The Document Library `doc_type` rule and CHECK, `homeowner_shared_documents` (guard trigger, RLS, policies), the public homeowner share readers. | SQL 29, SQL 90 (SQL 30 optional) |
| `sql95` | `95_remove_freedom_claims_bridge.sql` (`0cf0dafd…`) | Drops `trg_notify_freedom_status_change`, `notify_freedom_status_change()`, `list_checks_by_freedom_claim(text, uuid)`, `aws_ingest_shared_check(jsonb)`, `vault_create_bridge_secret(text)`, `vault_update_bridge_secret(text)`. | — (Lambda gate, below) |
| `sql96` | `96_platform_owner_tenant_pricing.sql` (`18109fed…`) | `tenant_pricing_audit` and its trigger, `aws_platform_owner_set_tenant_pricing(uuid, jsonb)`, the replaced `aws_tenants_member_column_guard()`, platform-owner-only `platform_fee_schedules` writes. | SQL 93 |
| `sql97` | `97_financial_stepup_log_server_writer.sql` (`e3c8fd41…`) | `INSERT` on `financial_stepup_log` revoked from PUBLIC and `authenticated`, granted to `checksops`; the `aws_financial_stepup_log_writer_guard` BEFORE INSERT trigger. | — (Lambda gate, below) |
| `sql98` | `98_tenant_fee_collection.sql` (`5a42e485…`) | Per-check price stamping (`record_check_billing_event()` and `trg_record_check_billing_event`, the `check_billing_config` default and the owner-question switch, a seed config row only when the table is empty); one charge per tenant period (`tenant_maintenance_payments_tenant_period_uidx`); `check_billing_events` unique (check, event) index when none covers it; `platform_billing_destination` (platform owner only, audited), `platform_billing_audit`, `tenant_fee_invoice_outbox`, `aws_platform_owner_record_billing_audit(jsonb)`; `tenants.deposits_enabled` with `aws_tenant_deposits_enabled(uuid)`, `aws_platform_owner_set_tenant_deposits_enabled(uuid, boolean)` and its audit trigger; SQL 96's `aws_tenants_member_column_guard()` replaced (plus `deposits_enabled` for the platform owner). | SQL 96 |
| `sql99` | `99_mortgage_desk_completion_messages.sql` (`0c079fe4…`) | `aws_mortgage_desk_appended_note(text, text)`, the SECURITY DEFINER trigger function `aws_mortgage_desk_completion_messages()` and `tr_mortgage_desk_completion_messages` on `mortgage_handling_requests`. | SQL 90 |
| `sql100` | `100_mortgage_desk_live_access.sql` (`16cb8c9a…`) | Records production's live Mortgage Desk access: `aws_is_mortgage_ops_agent()`, `aws_mortgage_agent_queue_visible(text, uuid)`, `aws_is_active_mortgage_agent(uuid)`; the five live `mortgage_handling_requests` policies (drops the repository-only `aws_write_mortgage_handling_requests`); `checksops` table SELECT / INSERT / DELETE and UPDATE on 17 columns, `authenticated` UPDATE on three columns only; the helpers' live EXECUTE grants and the Accept / Complete policy's live comment. A strict no-op on production. | SQL 90 (and 12 / 24 / SQL 50, already live) |
| `sql101` | `101_invite_identity_insert_order.sql` (`5a5e2617…`) | Replaces SQL 90's `aws_invite_create_user_identity(uuid, text, text, text)` (same signature, attributes, comment and ACL) so a new user's `identity_accounts` row is inserted before its profile: staging and production have `profiles_id_identity_fkey` (`aws/rls/sql/25_fk_retarget.sql`), and under SQL 90 every invite of a brand-new email fails with 23503 (staging, 2026-10-18). Supersedes SQL 90 (spec `supersedes`). | SQL 90 |
| `sql102` | `102_platform_owner_tenant_profile.sql` (`7ef8736b…`) | `aws_tenant_profile_columns()`, the platform owner's `aws_platform_owner_set_tenant_profile(uuid, jsonb)` (name, custom domain, subscription status, monthly check limit, test account with `moov_environment` following and locked once a Moov account exists, KYC status and notes, internal notes; slug and partner code permanent) and `aws_platform_owner_remove_tenant_member(uuid, uuid)`; `aws_tenant_has_moov_account(uuid)`; the SECURITY DEFINER `aws_tenant_profile_audit_row()` and trigger `aws_tenant_profile_audit` (AFTER UPDATE on `tenants`, one `tenant_pricing_audit` row per changed profile field); SQL 98's `aws_tenants_member_column_guard()` replaced (plus the profile fields and `moov_environment` for the platform owner; on every path `moov_environment` changes only with `is_test_account`, and neither once the tenant has a Moov account). Supersedes SQL 98 (spec `supersedes`, pin `superseded_intended_sha256`). | SQL 98 |

## Tooling

| piece | where |
|---|---|
| Engine (state reader, fingerprints, predecessor rules, pre/post conditions, unrelated snapshot) | `scripts/deployment-guard/lib/release-sql-state.mjs` |
| Specs (objects, reviewed ACLs, PostgreSQL renderings) | `scripts/deployment-guard/lib/release-sql-specs.mjs` |
| Staging pins (`AUTHORIZED_SQL9x_*`, `AUTHORIZED_SQL100_*`, `AUTHORIZED_SQL101_*`, `AUTHORIZED_SQL102_*`, `RELEASE_2026_10_17_PENDING_SQL_PINS`; SQL 98 also as `FEE_COLLECTION_PENDING_SQL_PINS.sql98`) | `scripts/deployment-guard/lib/sql-executor-auth.mjs` |
| Staging executor handler | `handleReleaseSqlMigration` in `aws/write-path/guarded-sql-executor/index.mjs` |
| Staging workflow choices | `.github/workflows/guarded-staging-sql-executor.yml`: `sql90-users-only-tenant-roles`, `sql91-moov-onboarding`, `sql92-signature-request-check-files-link-grant`, `sql93-tenant-company-info`, `sql94-document-library-restore`, `sql95-remove-freedom-claims-bridge`, `sql96-platform-owner-tenant-pricing`, `sql97-financial-stepup-log-server-writer`, `sql98-tenant-fee-collection`, `sql99-mortgage-desk-completion-messages`, `sql100-mortgage-desk-live-access`, `sql101-invite-identity-insert-order`, `sql102-platform-owner-tenant-profile` |
| Production tools | `scripts/deployment-guard/sql9x-*-production-apply.mjs`, `sql100-mortgage-desk-live-access-production-apply.mjs`, `sql101-invite-identity-insert-order-production-apply.mjs`, `sql102-platform-owner-tenant-profile-production-apply.mjs` (one per key) on `lib/release-sql-production-apply.mjs` and `lib/release-sql-production-cli.mjs` |
| Production pins | `ops/deployment-guard/sql9x-*-production-apply.json`, `sql100-mortgage-desk-live-access-production-apply.json`, `sql101-invite-identity-insert-order-production-apply.json`, `sql102-platform-owner-tenant-profile-production-apply.json` |
| One-shot | `production-sql-one-shot.mjs --migration sql90` … `sql102` (`ops/production-sql-one-shot.md`) |
| Tests | `aws/tests/release-sql90-97-executor.test.mjs`, `aws/tests/release-sql90-97-production-apply.test.mjs`, `aws/tests/release-sql98-100-executor.test.mjs`, `aws/tests/release-sql98-100-production-apply.test.mjs`, `aws/tests/release-sql101-executor.test.mjs`, `aws/tests/release-sql101-production-apply.test.mjs`, `aws/tests/release-sql102-executor.test.mjs`, `aws/tests/release-sql102-production-apply.test.mjs` (PostgreSQL 16: `sudo -n -u ubuntu env PATH=$PATH node --test …`), fixture `aws/tests/helpers/release-sql-pg.mjs` (`sql98To100Schema()`); per-file behaviour: `tenant-fee-collection-sql98-pg.test.mjs`, `tenant-deposits-switch-pg.test.mjs`, `sql99-mortgage-desk-completion-messages-pg.test.mjs`, `sql100-mortgage-desk-live-access-pg.test.mjs`, `sql101-invite-identity-insert-order-pg.test.mjs`, `sql102-platform-owner-tenant-profile-pg.test.mjs` |
| Staging Lambda hold | `scripts/deployment-guard/github-staging-lambda-overlay.mjs` refuses an apply of a member whose plan entry has `sql_before` until `ops/deployment-guard/staging-sql-live.json` records that file `verified_live: true` (below) |

## Apply order

Staging first for every step, with a staging acceptance reference recorded in the
production pin before the matching production step (deltas report
`ops/release-2026-10-17-lock-pin-deltas.md` §5):

1. Deploy main's guarded SQL executor package (it carries the SQL 29/30 and SQL 90-97
   handlers and the files) through its reviewed path (`mode: deploy`).
2. **SQL 29 → SQL 30** (`ops/production-sql-29-30-apply.md`).
3. **SQL 90**, then right away **SQL 101** (step 12) and the step-6 Lambdas (invites break
   between SQL 90 and the new `tenant-admin.mjs`, and an invite of a brand-new email fails with
   23503 on `profiles_id_identity_fkey` until SQL 101 replaces SQL 90's
   `aws_invite_create_user_identity`); SQL 90 also goes before `tenant-admin.mjs` /
   `workflow-rpc.mjs`, and SQL 101 before `tenant-admin.mjs` (operator gate, below).
4. **SQL 93** and **SQL 94** (either order, both after SQL 90). SQL 93 before
   `write-allowlist.mjs` / `write-app-metadata.mjs`; SQL 94 before the library Lambdas (step 7).
5. **SQL 91** and **SQL 92** any time before their Lambdas (`providers/onboarding/*`; `esign.mjs`,
   soft).
6. **SQL 96** after SQL 93, before `tenant-billing-engine.mjs` / `tenant-billing-handlers.mjs`.
   **Never re-run SQL 93 after SQL 96**: the SQL 93 tools refuse once SQL 96's setter exists
   (`successors_not_applied`).
7. **SQL 97** only after `auth-financial-totp.mjs` and `admin-reset-totp.mjs` are live (both set
   `app.stepup_writer`); before then the server's step-up insert would be refused.
8. **SQL 95** only after `app-services.mjs` and the `ingest-shared-check.mjs` 410 stub are live
   (plan step 8); it drops SQL 70's `aws_ingest_shared_check`.
9. **SQL 98** after SQL 96 (SQL 98 requires SQL 96's pricing setter and replaces its column
   guard), **before** `tenant-billing-engine.mjs`, `tenant-billing-handlers.mjs`,
   `workflow-rpc.mjs` and `providers.mjs` (`ops/fee-collection-deltas.md` sections 2 and 4: the
   deposits gate in `workflow-rpc.mjs` and `providers.mjs` fails closed without SQL 98's
   `aws_tenant_deposits_enabled(uuid)`, so every deposit would refuse; a pull or verify-debit
   refuses with `billing_audit_unavailable`). The plan's `sql_before` holds those four in
   production (`sql_prerequisites[...98...].verified_live`) and now in staging too
   (`staging-sql-live.json`). **Never re-run SQL 96 after SQL 98**: the SQL 96 tools refuse once
   SQL 98's `aws_platform_owner_set_tenant_deposits_enabled` exists (`successors_not_applied`).
10. **SQL 99** after SQL 90, as the login that owns `check_messages` (no FORCE RLS) and
   `mortgage_handling_requests`; before or with the SPA build that stops the Mortgage Desk
   client posts (`MortgageOpsQueue.tsx`). No Lambda dependency.
11. **SQL 100** after SQL 90 (and 12 / 24 / SQL 50, already live). Staging only: on production it
   is a strict no-op and is recorded by the read-only inspect (below). In staging it brings
   the Mortgage Desk access to production's.
12. **SQL 101** after SQL 90 (it refuses with `sql101_prerequisite_missing` without SQL 90's
   function and helpers), in production too, as soon as SQL 90 is in: it replaces only
   `aws_invite_create_user_identity`, inserting the `identity_accounts` row before the profile.
   **Before** `tenant-admin.mjs`: the plan's `sql_before` still holds it on SQL 90 only, so
   this is the operator's gate (like SQL 95 / 97's), to check before that overlay and record in
   the pin change that sets `execute: true`. **Never re-run SQL 90 after SQL 101**: it
   would put the profile-first insert back. SQL 101 supersedes SQL 90 (spec `supersedes`), so
   once it is in place SQL 90 still counts as applied for SQL 93, 94, 99 and 100. Independent of
   SQL 91-100 in the database.
13. **SQL 102** after SQL 98 (it refuses with `sql102_prerequisite_missing` without SQL 98's
   deposits setter and SQL 96's pricing helpers and audit table), **before** the
   `tenant-billing-handlers.mjs` overlay that calls its `profile-update` and `member-remove`
   actions: the plan's `sql_before` still holds that member on SQL 98 only, so this is the
   operator's gate, to check before that overlay and record in the pin change that sets
   `execute: true`. **Never re-run SQL 98 after SQL 102**: SQL 98's tools refuse once
   `aws_platform_owner_set_tenant_profile` exists (`successors_not_applied`), and a re-run would
   put SQL 98's guard back (fail closed: the platform owner could no longer save the profile).
   SQL 102 supersedes SQL 98 (spec `supersedes`; pin `superseded_intended_sha256.sql98`), so
   once it is in place SQL 98 (and through it SQL 96 and SQL 93) still counts as applied, but
   only while every other SQL 98 object still matches. Independent of SQL 99-101.

Exact order used by the tests: 29 → 30 → 90 → 91 → 92 → 93 → 94 → 96 → 97 → 95 → 98 → 99 →
100 → 101 → 102. SQL 98, SQL 99, SQL 100 and SQL 101 are independent of each other in the database;
99, 100 and 101 only need SQL 90. The engine enforces the database-visible part (predecessors,
prerequisites, SQL 93 after SQL 96, SQL 96 after SQL 98, SQL 98 after SQL 102). It cannot see
Lambda state: the SQL 95 and SQL 97 gates (and SQL 101 before `tenant-admin.mjs`, SQL 102 before
`tenant-billing-handlers.mjs`) are the operator's to check (the
deployed member SHA-256s from `guarded-staging-lambda-overlay.yml` / the production overlay inspect) and to record in the pin
change that sets `execute: true`; the SQL 98 hold on the Lambdas is enforced by the overlays'
`sql_before` in both environments.

### Staging `sql_before` (the staging overlay)

Before this change the staging Lambda overlay took any member by name and did not consult the
plan, and there was no staging record of which SQL is live (only a free-text `staging` note on
one production prerequisite). `ops/deployment-guard/staging-sql-live.json` is that record, and
nothing more: per SQL file, `verified_live` and `evidence` (the guarded staging SQL executor
run). `github-staging-lambda-overlay.mjs` in `apply` mode reads the member's `sql_before` from
`production-api-overlay-plan.json` and refuses (`DEPLOYMENT_COLLISION`, before any AWS call,
lease or receipt) unless that file is recorded `verified_live: true` there; a file missing from
the record is not live. `inspect` reports the hold. After a staging apply of SQL 90, 91, 93, 94
or 98, record it there (with the run id) in a reviewed change before overlaying the members it
holds. The record already marks SQL 53, the 20261007193200 ledger SQL, SQL 81, SQL 85 and SQL
89 live in staging, from the staging acceptance runs their production pins record.

## Fingerprints

`live_definition_sha256` is `sha256(releaseStateText(key, state))`: one line per object the
file creates, replaces or drops. Functions: language, volatility, parallel, SECURITY DEFINER,
result type, `proconfig`, `sha256(prosrc)` and the EXECUTE ACL (owner read as `owner`).
Policies: cmd, permissive, roles and `sha256` of the whitespace-collapsed `pg_get_expr`
USING / WITH CHECK (`search_path` `pg_catalog`). Views, constraints, indexes and triggers:
`sha256` of the collapsed definition. Created tables: RLS, every column (type, NOT NULL,
default, column ACL), constraint, index, policy and trigger name and the non-owner ACL. Owner
names are not part of it, so the post-state hash is the same in staging and production.

The intended state is code-derived (`releaseIntendedHash`): function attributes and bodies
from the pinned file's bytes; renderings from the reviewed constants in
`release-sql-specs.mjs`, re-derived by the PostgreSQL 16 test that applies the real files.

| key | intended_replacement_sha256 |
|---|---|
| `sql90` | `1351f1d5d7f802640a61b95198248f88561ed58b667192ebdf3f1b615b00105c` |
| `sql91` | `f8611dcca3397f684a247de454c8737074b3d2fb03c52e28fba665d0f297967d` |
| `sql92` | `805deb65c877f9a2ff1ed9cd7f4b72b7643524dd7a94fbf5d1efc516b8b75762` |
| `sql93` | `1032695c682d08934f5d4213e866df30100bd7ad855fb84cd4a4fbb9dc7aae58` |
| `sql94` | `1cdc503275592900e9bf4ef49f7f5eadba573cab5f46dda3f4da9190dbe6ea57` |
| `sql95` | `a737e4ecdc114a456aa698b71f41cac7182218995c8e17517dd6162cafc1f9c2` |
| `sql96` | `ea844355e6854ad56f7e4058b5967591ff6c49b79748babc217f0321a47e7767` |
| `sql97` | `5d9b50f5c71da4ca06810c229a67ff1dfd3839ecba83ba4e1829da15eb28edef` |
| `sql98` | `abcb8f21b5a3840e6aa1dfd6639302ae82927b6fa66cf7b13351fa39c63ab603` |
| `sql99` | `481ac0f1f368459d2695fba81bcb301d66dd82a420d8b7fcd956f2610e459fb4` |
| `sql100` | `52c00e3a3fb401107fd6a0316685a7e7d40b4ebdd42b82899acf7a16831ef777` |
| `sql101` | `4383ef98de0b86d159ac7795b8cef1cc4d998d3540099dafed8078994d4c281b` |
| `sql102` | `6e1346af3dee0bcdc0dc6269299de63e9e2804568e5bdecbd51ff062669700fd` |
| `sql103` | `4b909c5929f0357ef442a1b2ebcb6bf8312e93be257010ed8a32072accf02aae` (its own runbook: `ops/production-sql-103-apply.md`) |

SQL 98's fingerprint also has a line for `tenant_maintenance_payments_tenant_period_uidx` (an
index on an existing table) and one for whether a unique index covers `check_billing_events
(check_intake_item_id, event_type)`: SQL 98 creates `check_billing_events_check_event_uidx` only
when none does, so the fingerprint records the covering, not which index provides it, and is
the same either way. SQL 100's fingerprint (spec `render`) also carries each ACL entry's
grantor (the owner as `owner`) for the helpers' EXECUTE, the column UPDATE grants and the table
privileges of `checksops` / `authenticated` on `mortgage_handling_requests`, and the sha256 of
each policy's comment (never the text): a grant by another grantor, a widened helper EXECUTE
or a policy comment other than the recorded one is a different state.

Staging is PostgreSQL 18 (production too); the tests run PostgreSQL 16. The renderings are
collapsed to single spaces to absorb pretty-print differences, and table constraints leave out
PostgreSQL 18's named NOT NULL constraints (contype `n`): the column's `notnull` carries them,
and PostgreSQL 16 has none (the 2026-10-17 production inspect showed six on
`platform_billing_destination`, which made the take-over shape differ). If a staging read-live after apply reports
an object as `different` although the file ran, stop: the apply has rolled back (the
post-condition is the intended hash); reconcile the rendering in a reviewed change.

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

- `prerequisites_present`: the file's own prerequisite objects, plus every object it changes
  only "when present" (SQL 90: the SQL 35 helper and view, SQL 29's and SQL 80's functions,
  `tenant_email_settings`, `checkalt_tenant_accounts`, `contractor_profiles`,
  `deposit_batches`, `homeowner_check_uploads`, `referral_events`, `tenant_partnerships`;
  SQL 92: `check_files.signature_request_id` (the file would otherwise skip silently); SQL 96:
  `platform_fee_schedules`), so the post-state is fixed.
- `predecessors_applied`: SQL 29 by structure (its five functions and two policies, no other
  policy), SQL 30 by its CHECK (SQL 30's or SQL 94's), a release migration by its own
  fingerprint (or, once superseded, its successor's: SQL 93 by SQL 96, SQL 96 by SQL 98, SQL 90
  by SQL 101, SQL 98 by SQL 102). A partial successor (SQL 101, SQL 102) pins
  `superseded_intended_sha256`: the earlier migration's other objects must still match.
- `successors_not_applied`: SQL 93 refuses once `aws_platform_owner_set_tenant_pricing` exists;
  SQL 96 once `aws_platform_owner_set_tenant_deposits_enabled` exists; SQL 98 once
  `aws_platform_owner_set_tenant_profile` exists.
- `altered_relations_owned_by_login`, `functions_owned_by_login`, `dropped_functions_owned_by_login`.
- `function_results_match`; `function_acl_replaceable` (no EXECUTE grant the file neither
  keeps nor revokes: CREATE OR REPLACE keeps an existing ACL).
- `created_tables_absent_or_intended`, `added_columns_absent_or_intended`,
  `column_acl_replaceable`, `dropped_functions_have_no_other_dependents` (SQL 95, `pg_depend`)
  and `dropped_functions_not_called_by_other_functions` (SQL 95: no other `public` / `auth`
  function body names a function it drops; the inspect lists the callers' identities and count).
- Staging apply additionally needs the staging pin itself to say `execute: true` with an
  `Owner approved …` authorization (read-live works while it is pending).
- The file may not contain, anywhere (DO blocks and function bodies included), `SET [LOCAL]
  ROLE`, `SESSION AUTHORIZATION`, `session_replication_role`, `set_config('role' | …)`,
  `ALTER DEFAULT PRIVILEGES`, a role `GRANT` / `REVOKE` (no `ON`), role DDL or `REASSIGN` /
  `DROP OWNED`.
- SQL 94: `doc_type_check_supported` (3- or 6-value predecessor, SQL 30's or already SQL 94's)
  and `no_rows_outside_sql94_rule` (aggregate COUNT(*), the only row read).
- SQL 98 (aggregate COUNT(*)s, the only rows read): `no_duplicate_billing_periods` (the file
  raises 23505 otherwise), `unique_covered_or_no_duplicates` (with duplicated (check, event)
  rows and no covering unique index the file would only warn and skip the index),
  `check_billing_config_active_or_empty` (an active default price, or no row so the file seeds
  300); `added_indexes_absent_or_intended`; `created_tables_absent_or_intended` takes over a
  pre-existing `platform_billing_destination` only when it is owned by the login and has the
  reviewed columns, constraints and indexes (FORCE off), no trigger but the file's and
  privileges only of PUBLIC, `authenticated` and `checksops` (the roles the file revokes from;
  any other policy is dropped by the file), and `platform_billing_destination_absent_empty_or_reviewed`
  only while it holds no row or exactly the reviewed one (counts only: one row, production, on
  the owner-confirmed platform account `41cb5d67-…`, with a payment method, verified; owner
  decision 2026-10-17, the row live in production): any other row would become the fee
  destination unreviewed, so it is refused and reconciled in a reviewed change. In staging (the
  guarded staging executor, Moov sandbox; owner decision 2026-10-17, option A) the kept row is
  instead exactly one verified `sandbox` row with a payment method and no `production` row (the
  2026-10-17 staging read-live, run 39076252693, showed that row); the sandbox account is not
  compared with a reviewed id. The production tool keeps the reviewed-row rule. The payment
  method id is not compared with a reviewed value (none is recorded); the kept row has no audit
  history before SQL 98 creates the audit trigger. `successors_not_applied` on SQL 96 once SQL 98 is in
  place.
- SQL 99: `definer_can_write_relations` (`check_messages`: superuser, BYPASSRLS, or a member of
  the owner and no FORCE RLS, the file's own check); `altered_relations_owned_by_login`
  (`mortgage_handling_requests`, for CREATE TRIGGER).
- SQL 100: `column_acl_replaceable` (every live column grant is one the file keeps or revokes;
  with grantors, so a grant by another role the owner's REVOKE cannot remove refuses);
  `function_acl_replaceable` (CREATE OR REPLACE keeps an existing EXECUTE ACL: only the default
  PUBLIC + owner is accepted); on production also `production_state_already_intended`.

Post-conditions (inside the transaction, before COMMIT): the intended fingerprint; functions
and created tables owned by the login; owners of altered relations unchanged; SQL 97: every
other privilege on `financial_stepup_log` unchanged; and everything else in schema `public`
(relations, columns, constraints, indexes (`pg_get_indexdef`), policies, triggers, views,
types, schema ACL), every function of `public` and `auth` (all attributes, defaults and
`pg_get_functiondef`), default privileges, role memberships and role attributes unchanged.

## Inspect (read-only)

```bash
node scripts/deployment-guard/sql90-users-only-tenant-roles-production-apply.mjs --inspect
# … sql91 … sql97 likewise
```

`BEGIN READ ONLY … ROLLBACK`, `search_path` `pg_catalog`. It prints `live_definition_sha256`
(the value to pin), `already_applied`, `missing_dependencies`, `predecessors`,
`successors_applied`, `precondition_failures`, `apply_preconditions_met` and
`release_sql_inspect`: per object `intended` / `different` / `absent` (`present` for one the
file drops), function ACL lines, table column / policy counts and, for SQL 94,
`counts.rows_outside_sql94_rule`; SQL 98: `counts` (`duplicate_billing_periods`,
`check_billing_event_duplicates`, `check_billing_config_rows`,
`check_billing_config_active_rows`), `indexes`, `unique_covers`; SQL 99: `definer_writes`;
SQL 100: `policy_comments` (present only) and `production_noop`. No ids, owner names,
definitions, emails or row data.

```bash
node scripts/deployment-guard/sql98-tenant-fee-collection-production-apply.mjs --inspect
node scripts/deployment-guard/sql99-mortgage-desk-completion-messages-production-apply.mjs --inspect
node scripts/deployment-guard/sql100-mortgage-desk-live-access-production-apply.mjs --inspect
node scripts/deployment-guard/sql101-invite-identity-insert-order-production-apply.mjs --inspect
node scripts/deployment-guard/sql102-platform-owner-tenant-profile-production-apply.mjs --inspect
```

## Steps (per key, in the order above)

1. **Staging read-live**: run `guarded-staging-sql-executor.yml` with `mode: read-live` and the
   key's choice. Record `LIVE_DEFINITION_SHA256` as the staging pin's
   `expected_live_definition_sha256` (in `sql-executor-auth.mjs`) in a reviewed change. If
   `precondition_failures` is not `[]`, stop: that needs its own reviewed change.
2. **Staging apply**: `mode: apply` with that hash; then `read-live` again (`already_applied` true).
3. **Production inspect** on the SQL53 runner through the one-shot (`--phase inspect`) or the
   tool's `--inspect`. The SSM command carries only the tarball path, its sha256 and the
   one-shot flags: **never a password or connection string**; the tools read the
   `checksops_admin` secret through the Secrets Manager VPC endpoint and refuse credential flags.
4. **Production pin change** (reviewed, owner-approved): record `production_inspect`, copy its
   `live_definition_sha256` into `expected_live_definition_sha256`, record the staging runs in
   `staging_acceptance`, set the owner's `authorization` and `execute: true`. For SQL 95 and
   SQL 97 also record the live Lambda member evidence for their gate.
5. **Production apply**: `production-sql-one-shot.mjs --migration sql9x --phase apply` with the
   owner's approval statement (preflight `--acquire-lease --receipt`, evaluate, apply with the
   phrase and a fresh `one_use_id`, post-apply inspect).
6. **Record and retire**: record `applied` in the pin and set `execute: false` again.

## Review notes on the files (not changed by this tooling)

- SQL 90 hard-codes the platform owner email (`checksopsadmin@gmail.com`) in
  `aws_is_platform_owner_user` and `aws_invite_create_user_identity`, matching
  `is_platform_owner()`; a change of that email needs all three changed together.
- SQL 90 recreates `aws_write_tenant_partnerships`, `aws_write_deposit_batches`,
  `aws_write_homeowner_check_uploads` and `aws_write_referral_events` from SQL 24 without the
  cross-tenant-reader branch; deposit batch creation then works only through
  `aws_create_deposit_batch_for_item` (DEFINER).
- SQL 93 / SQL 96's guard refuses every end-user `tenants` UPDATE of a column outside the
  member list (or, for the platform owner, the pricing list), including ones made by a
  SECURITY DEFINER function running under a caller. Confirm no live request path updates
  other `tenants` columns (e.g. `moov_*`, `partner_code`, `kyc_*`) with a caller set before
  applying SQL 93.
- SQL 97's guard is BEFORE INSERT only. A role that keeps UPDATE on `financial_stepup_log`
  could still rewrite an existing row's `metadata`. The inspect lists any non-owner UPDATE,
  DELETE or TRUNCATE grant on the table in
  `release_sql_inspect.table_privileges[0].other_write_grants`; if it is not `[]` (for example
  `authenticated UPDATE`), stop and decide in a reviewed change before applying SQL 97.
- SQL 92 skips silently when `check_files.signature_request_id` is missing; the tooling makes
  that a prerequisite instead.
- SQL 94 drops and re-adds `tenant_documents_doc_type_check` (ACCESS EXCLUSIVE on
  `tenant_documents` and a full validation scan); the tools run with `lock_timeout` 5s.

- SQL 98 inserts one `check_billing_config` row (300, usd, active) only when the table is
  empty; the inspect's `counts.check_billing_config_rows` shows whether it will. The live default
  price is owner question (b)'s answer.
- SQL 98 drops every policy on `platform_billing_destination` but its two and resets
  `checksops` to SELECT, INSERT, UPDATE; that removes the `aws_monthly_billing_job()` read path.
  The inspect labels the table `different` until SQL 98 ran; its policy count is reported.
- SQL 98's `record_check_billing_event()` replaces any live body (the DB copy restored the
  Supabase trigger); `function_acl_replaceable` refuses if the live function has EXECUTE grants
  beyond PUBLIC (for example to `authenticated`), which REVOKE ALL FROM PUBLIC would leave.

## SQL 100 on production

SQL 100 writes production's 2026-10-17 state down; applied to production it must change
nothing. The production tool therefore never runs the file there:

1. `sql100-mortgage-desk-live-access-production-apply.mjs --inspect` (read-only, the owner runs
   it). Production is recorded when `already_applied` is `true` (`live_definition_sha256` equals
   `52c00e3a…`), `production_noop.live_is_intended` is `true` and `precondition_failures` is
   `[]`. Record that run in the SQL 100 production pin (`production_inspect`) and in
   `production-api-overlay-plan.json` if a member ever needs it.
2. If `live_definition_sha256` differs, SQL 100 does not describe production (for example a
   helper EXECUTE grant other than the recorded ones, a grant whose grantor is not
   `checksops_admin`, a policy comment other than the recorded one, or anything on `mortgage_handling_requests` the file
   does not name: RLS off or forced, another policy, a table grant to any other role (PUBLIC
   included) or a grant on an unlisted column; the fingerprint covers the table's whole access
   surface, spec `whole_tables`). Stop: reconcile the file in a reviewed change. Do not
   apply it. The tool refuses anyway: `production_state_already_intended` while the state
   differs, and `already in place` once it is intended. `mortgage-desk-access-production-inspect.mjs`
   shows which: `execute_acl`, `comment`, `column_acl_entries[].grantor`.
3. The SQL 100 pin stays `execute: false`; no production apply step exists for it.

## Later migrations (SQL 103 and up)

Adding one means: its spec in `release-sql-specs.mjs`, its staging pin (with its code-derived
`intended_replacement_sha256`) in the release pin map of `sql-executor-auth.mjs`, its file in
`EXECUTOR_PACK_MEMBERS`, its workflow choice, its production pin and a thin
`scripts/deployment-guard/sqlNNN-…-production-apply.mjs`, plus its bypass-inventory entry. The
engine, the executor handler, the production library and CLI, and the one-shot registration
are generic.

## Staging apply waves (2026-10-17)

The staging pins record each migration's staging read-live pre-state. A pre-state stays valid
only if no earlier migration changes that migration's objects. From the specs, three do:
- SQL 94 (on SQL 30): the `tenant_documents` doc_type CHECK.
- SQL 96 (on SQL 93): `aws_tenants_member_column_guard()`.
- SQL 98 (on SQL 93 and SQL 96): the same function.
- SQL 102 (on SQL 93, SQL 96 and SQL 98): the same function.

- **Already applied in staging:** SQL 29 and SQL 92 (read-live runs 39074958756 and
  39075498539, `already_applied` true); they are not re-applied.
- **Wave 1 (owner approved 2026-10-17):** SQL 30, 90, 91, 93, 99 and 100, from the read-live
  runs recorded in their pins (executor at main `ecb8647b0`; SQL 90 re-read at `3cad3c227`).
  Redeploy the guarded executor at the merged commit first (the pins are in its package).
- **Applying:** one guarded staging apply per migration, in release order:
  30 → 90 → 91 → 93 → 99 → 100. SQL 90 breaks invites until `tenant-admin.mjs` is live (step 3),
  so the staging Lambda overlay for the members held on SQL 90 follows right after.
- **SQL 95 and SQL 97 are not in wave 1:** they go only after their Lambdas are live (steps 7 and
  8: `auth-financial-totp.mjs` / `admin-reset-totp.mjs`; `app-services.mjs` and the
  `ingest-shared-check.mjs` 410 stub). Their pins get `execute: true` in the reviewed change
  that records those Lambdas live.
- **Wave 1 applied 2026-10-17** at main `c8a79d554`, each receipt on the intended fingerprint:
  SQL 30 (run 39080001060), 90 (39080157856), 91 (39080306273), 93 (39080438659),
  99 (39080577323), 100 (39080713230). SQL 90, 91 and 93 are recorded in `staging-sql-live.json`.
- **Wave 2:** SQL 94 (after SQL 30) and SQL 96 (after SQL 93), re-read at `c8a79d554` (runs
  39080904425 and 39081015501, precondition_failures []) and pinned for apply.
  **Applied 2026-10-18** at main `02fb97d5a` (executor `Kmln7zaw…`), each receipt on the intended
  fingerprint: SQL 94 (run 39082817752), SQL 96 (39082957003). SQL 94 is recorded in
  `staging-sql-live.json` (SQL 96 is no plan member's `sql_before`).
- **Wave 3:** SQL 98 (after SQL 96), re-read at `02fb97d5a` (run 39083278136,
  precondition_failures []; the staging sandbox destination rule holds: 1 sandbox row, 0
  production rows) and pinned for apply. The first apply (run 39084622818) rolled back with
  `UNRELATED_MUTATION ["constraints"]`: PostgreSQL 18 records the added `tenants.deposits_enabled`
  NOT NULL as a named constraint, which the unrelated catalog now skips (PR #1030).
  **Applied 2026-10-18** at main `2176f73ae` (executor `f8fUm1GL…`, run 39085677318): receipt
  before `296c3d6a…`, after `abcb8f21…` = intended. Recorded in `staging-sql-live.json`.
- **Wave 4:** SQL 97 then SQL 95, after their Lambdas went live in the staging overlay of
  2026-10-18 at main `23953055e` (`auth-financial-totp.mjs`, `admin-reset-totp.mjs`, the
  `ingest-shared-check.mjs` 410 stub). Re-read at `23953055e` (SQL 97 run 39121540941, live
  `80bbcae1…`; SQL 95 run 39121392809, live `4e8f3745…`; precondition_failures [], no dropped
  function callers or dependents) and pinned for apply (owner approved 2026-10-18). Redeploy the
  guarded executor at the merged commit before applying.
- **Wave 5:** SQL 101 (fixes SQL 90's invite insert order; `profiles_id_identity_fkey` refused
  brand-new invites on staging). Re-read at `0d4a7b8a8` (run 39142701783, live `1c7e1d52…`,
  precondition_failures [], predecessor sql90 true) and pinned for apply (owner approved
  2026-10-18). Redeploy the guarded executor at the merged commit before applying.
- **Wave 6:** SQL 102 (the platform owner's tenant profile and member removal; after SQL 98).
  Re-read at `5c35bd09b` (run 39161620576, live `d3b2cd30…`, precondition_failures [], prerequisites
  missing [], predecessor sql98 true) and pinned for apply (owner approved 2026-10-18). Redeploy
  the guarded executor at the merged commit before applying.

Each apply refuses unless the live pre-state still equals its pin (`DEPLOYMENT_COLLISION`),
and records its post-state receipt. Record each in `ops/deployment-guard/staging-sql-live.json`
in a reviewed change.

## Production applies of SQL 91 and SQL 92 (2026-10-19)

One owner-approved run each ("approve 1055, apply SQL 91 in production and apply SQL 92 in
production") of `production-sql-one-shot.mjs` on `i-0c35557c4e5385406` from main `c62872827`
(tarball `a1f6a7b93a311069a9e0f0b3fc80d8aa6b739d50f9bb31e72d8e8cad13b53244`), SQL 91 first.
Every step was ok (pin, source, inspect, contracts, manifest, the two source rechecks,
preflight, evaluate, apply, post-apply inspect); contracts claim-ledger 4/4, tenant-isolation
6/6, financial-write-protections 43/43 for both.

| | SQL 91 | SQL 92 |
|---|---|---|
| SSM / run_id | `ed86d22d-d505-4479-b4ed-0402ab6ac349` / `d199f5d1-f17e-465e-a624-79564517bfb9` | `bf59603e-3b45-4229-bfb2-89a9d219a5f6` / `ad1efd53-8fdc-485c-8f8f-10e8d63befd5` |
| one_use_id (spent) | `sql91-prod-8e792cdc-48e2-40ce-97f2-79baea22ae3b` | `sql92-prod-eb132e5b-bfba-46e3-a3cc-52320cd64acf` |
| Migration source (== pin) | `199bfa1a…` | `ceef6482…` |
| Receipt | `bdbc697f…` -> `f8611dcc…` | `3cfbd32c…` -> `805deb65…` |
| Manifest | `7c4fe52e…` | `261bc3fd…` |
| Unrelated catalog | `d7f9a115…` | `79411e14…` (includes SQL 91's new objects) |
| Post-apply inspect | already_applied true, precondition_failures [] | already_applied true, precondition_failures [] |

SSM reported SQL 91's command as Failed (exit 1) only because the operator's trailing output
filter (a `grep` over the empty stderr) matched nothing after the one-shot had exited 0 with
every step ok. No later read-only inspect was run. Both pins are `execute: false` again; a
re-apply needs a new reviewed pin change. SQL 91's Lambdas (`providers/onboarding/*`) and
`esign.mjs` (SQL 92) may follow in their Lambda batches.
