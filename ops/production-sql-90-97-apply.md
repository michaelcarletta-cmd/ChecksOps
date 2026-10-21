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
retired after its apply. SQL 90 and SQL 101 were applied to production on 2026-10-19, in that
order (see "Production applies of SQL 90 and SQL 101" below), and their pins are retired; they
had been execute-authorized by the owner-approved pin changes of 2026-10-19 (SQL 90: the
read-only production inspect after SQL 29 / SQL 30, SSM `9e68e829-7ca0-4499-89ad-8cd691e3cdb8`,
live `b5a1998d…`, and the owner-accepted substitute staging evidence of the guarded staging apply
run `39080157856` from a different pre-state; SQL 101: the read-only inspect right after SQL
90's apply, live `1c7e1d52…`, and its guarded staging apply run `39143679543` from the same
pre-state). Invites of new users need the `tenant-admin.mjs` production overlay as well. SQL 93 was
applied to production on 2026-10-19 (see "Production apply of SQL 93" below) and its pin is
retired; it had been execute-authorized by the owner-approved pin change of 2026-10-19 (the
read-only production inspect after SQL 90 / SQL 101, SSM `d3753ba4-0338-4649-8997-2135376b6743`,
live `ef2ce6ba…`, and its guarded staging apply run `39080438659` from the same pre-state). Never
re-run SQL 93 after SQL 96. SQL 96 was applied to production on 2026-10-19
(see "Production apply of SQL 96" below) and its pin is retired; it had been execute-authorized
by the owner-approved pin change of 2026-10-19 (#1063: the read-only production inspect after
SQL 93, SSM `73b4bd93-b91b-44c9-b18d-287625e5f4c6`, live `275400ff…`, and its guarded staging
apply run `39082957003` from the same pre-state). SQL 94 was applied to production on 2026-10-19
(see "Production apply of SQL 94" below) and its pin is retired; it had been execute-authorized by
the owner-approved pin change of 2026-10-19 (#1068, "do the SQL 94 pin": the read-only production
inspect, SSM `70abaca3-3ec3-4cbc-aae3-6542563080f2`, live `72411598…`, and its guarded staging apply
run `39082817752` from the same pre-state). SQL 102 was applied to production on 2026-10-20
(see "Production apply of SQL 102" below) and its pin is retired; it had been execute-authorized by
the owner-approved pin change of 2026-10-19 (#1078, "approve the SQL 102 pin": the read-only
production inspect, SSM `3ff30ee9-031d-4122-9ee1-370a2645cbca` from main `96fb17821`, live
`d3b2cd30…`, and its guarded staging apply run `39162625974` from the same pre-state).
SQL 95's, SQL 97's and SQL 99's production pins were made `execute: true` by the owner-approved
pin change of 2026-10-21 (#1112, "Everything else should be pushed live no exceptions"): the
read-only production inspect of 2026-10-21 (SSM `43cb1d1f-f589-43b2-9315-7cad80fffb5c` from main
`69dbe9b01`, precondition_failures [] for each) is recorded as each pre-state (SQL 95 `48535b69…`,
SQL 97 `56b1f631…`, SQL 99 `4d174e86…`). SQL 99's staging acceptance is its wave 1 apply run
`39080577323` from the same pre-state; SQL 95's and SQL 97's are the guarded staging read-live runs
of 2026-10-21 (`39616185934`, `39618586101`, live = intended), owner-accepted substitute evidence
from a different pre-state (their wave 4 apply runs are not recorded). SQL 95 and SQL 99 were
applied to production on 2026-10-21 (see "Production applies of SQL 95 and SQL 99" below) and their
pins are retired (`execute: false`). SQL 97 was **not** applied: its pre-apply read-only inspect
reported `other_write_grants` on `financial_stepup_log`, so its one-shot was not run (see "SQL 97 not
applied" below). Its pin stays `execute: true` and unchanged; SQL 106 (revoke UPDATE/DELETE/TRUNCATE)
is to be applied first, and any SQL 97 apply still needs a fresh read-only inspect and the owner's
own run-time approval for that run.
Every other
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
   Production pin: `execute: true` (owner approved 2026-10-21). Gate evidence recorded in the pin:
   production runs the full main API package since the guarded production rebuild run
   `39588578627` (main `2168be9a1`, CodeSha256 `sxodWyRp…`, still live on 2026-10-21), and on main
   both files set `app.stepup_writer`. Not captured from the production inspect:
   `table_privileges[0].other_write_grants` (informational, not a precondition): read it in the
   one-shot's inspect step before the apply and stop if it is not `[]`.
   Not applied on 2026-10-21: the pre-apply read-only inspect reported `other_write_grants`
   `["checksops DELETE", "checksops UPDATE"]`, so it stopped by this rule (see "SQL 97 not applied"
   below). The pin keeps `execute: true`; SQL 106 comes first.
8. **SQL 95** only after `app-services.mjs` and the `ingest-shared-check.mjs` 410 stub are live
   (plan step 8); it drops SQL 70's `aws_ingest_shared_check`.
   Production pin: `execute: true` (owner approved 2026-10-21). Gate evidence recorded in the pin:
   the same rebuild run `39588578627`; on main `ingest-shared-check.mjs` is the 410 stub and
   `app-services.mjs` no longer calls `aws_ingest_shared_check`. The dropped-function dependents
   and callers counts were not captured; both are precondition rules, and precondition_failures
   was `[]`.
   Applied to production on 2026-10-21 (see "Production applies of SQL 95 and SQL 99" below) and
   its pin is retired. It went **before** SQL 97, not after it: SQL 97 stopped at its inspect, and
   SQL 97 is not a predecessor of SQL 95 (`predecessors: []`; the order came from the two Lambda
   gates, both live since run `39588578627`).
9. **SQL 98** after SQL 96 (SQL 98 requires SQL 96's pricing setter and replaces its column
   guard), **before** `tenant-billing-engine.mjs`, `tenant-billing-handlers.mjs`,
   `workflow-rpc.mjs` and `providers.mjs` (`ops/fee-collection-deltas.md` sections 2 and 4: the
   deposits gate in `workflow-rpc.mjs` and `providers.mjs` fails closed without SQL 98's
   `aws_tenant_deposits_enabled(uuid)`, so every deposit would refuse; a pull or verify-debit
   refuses with `billing_audit_unavailable`). The plan's `sql_before` holds those four in
   production (`sql_prerequisites[...98...].verified_live`) and now in staging too
   (`staging-sql-live.json`). **Never re-run SQL 96 after SQL 98**: the SQL 96 tools refuse once
   SQL 98's `aws_platform_owner_set_tenant_deposits_enabled` exists (`successors_not_applied`).
   Applied to production on 2026-10-19 (see "Production apply of SQL 98" below) and its pin is
   retired. It had been execute-authorized by the owner-approved pin change of 2026-10-19 (#1071,
   "accept the SQL 98 staging apply as substitute evidence and do the SQL 98 pin": the read-only
   production inspect, SSM `0c34e957-68f5-4ea5-9e2e-dd5639b7a67e` from main `b59b4520c`, live
   `d64218dc…`; staging's apply, run `39085677318`, went `296c3d6a…` -> `abcb8f21…` from a
   different pre-state, accepted as substitute evidence).
10. **SQL 99** after SQL 90, as the login that owns `check_messages` (no FORCE RLS) and
   `mortgage_handling_requests`; before or with the SPA build that stops the Mortgage Desk
   client posts (`MortgageOpsQueue.tsx`). No Lambda dependency.
   Production pin: owner approved 2026-10-21 (#1112): production live `4d174e86…`, the same
   pre-state staging applied from (run `39080577323`). Applied to production on 2026-10-21 (see
   "Production applies of SQL 95 and SQL 99" below) and its pin is retired.
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

## Production applies of SQL 90 and SQL 101 (2026-10-19)

Two owner-approved runs of `production-sql-one-shot.mjs` on `i-0c35557c4e5385406`, SQL 90 first
and SQL 101 right after it (SQL 101's pin change was reviewed and merged in between). Every step
was ok for both; contracts claim-ledger 4/4, tenant-isolation 6/6, financial-write-protections
43/43.

| | SQL 90 | SQL 101 |
|---|---|---|
| Owner approval | "apply SQL 90 in production" | "approve #1058 and apply SQL 101 in production" |
| Main / tarball | `ba9ff4261` / `94983f0e…` | `20e3826da` / `1f389eb5…` |
| SSM / run_id | `216d9a7e-8d5a-4c44-9d2f-e68370cc773a` / `8a427f65-58bc-4a1b-8aac-f5161017df60` | `680fd3f7-c586-4bb8-819e-cd4d7759d71b` / `9fd22ea1-d936-44a0-b33b-049a2257f601` |
| one_use_id (spent) | `sql90-prod-840d729b-39a5-4dbf-8e66-7aec6f4a3555` | `sql101-prod-9217d797-e85e-4d04-84d8-679f99aa6f00` |
| Migration source (== pin) | `488b2ec4…` | `5a5e2617…` |
| Receipt | `b5a1998d…` -> `1351f1d5…` | `1c7e1d52…` -> `4383ef98…` |
| Manifest | `b25796ef…` | `d32a3c71…` |
| Unrelated catalog | `d110205b…` | `7ba4bfca…` |
| Post-apply inspect | already_applied true, precondition_failures [] | already_applied true, precondition_failures [] |

SQL 101's pre-state was read in the same SSM command as SQL 90's apply. No later read-only
inspect was run. Both pins are `execute: false` again; a re-apply needs a new reviewed pin
change, and SQL 90 must never be re-run after SQL 101. Invites of new users stay broken until the
`tenant-admin.mjs` (and `workflow-rpc.mjs`) production overlay, which needs the staging
acceptance reference.

## Production apply of SQL 93 (2026-10-19)

One owner-approved run ("approve #1060 and apply SQL 93 in production") of
`production-sql-one-shot.mjs` on `i-0c35557c4e5385406` from main `4864023611` (tarball
`795d1274…`): SSM `a3696b55-52c2-4674-bd11-35153197191c`, run_id
`885c6403-0a2e-482b-920e-05e917897bc7`, one_use_id `sql93-prod-9956de5f-c4d5-4b14-9215-04ec7147f131`
(spent), migration source `d90ec7f9…` (== pin). Every step was ok; contracts claim-ledger 4/4,
tenant-isolation 6/6, financial-write-protections 43/43; manifest `851c1dd1…`; receipt
`ef2ce6ba…` -> `1032695c…`, unrelated catalog `0b6e6247…`; post-apply inspect already_applied
true, precondition_failures []. No later read-only inspect was run. The pin is `execute: false`
again; a re-apply needs a new reviewed pin change. `write-allowlist.mjs` and
`write-app-metadata.mjs` may follow in their Lambda batch; SQL 96 is next in the database.

## Production apply of SQL 96 (2026-10-19)

One owner-approved run ("approve 1063 and apply SQL 96 into production") of
`production-sql-one-shot.mjs` on `i-0c35557c4e5385406` from main `b9a1591f9` (tarball
`6edc5ede…`), after a read-only `--phase inspect` run of the same one-shot (SSM
`70c6b6a0-6f92-4a99-b2ef-f58a286c49fd`) that reported the recorded pre-state: SSM
`df0acdce-9d1f-401c-a0f6-f6232e5d3f74`, run_id `6de41c7e-81c2-45a4-b92c-e4dc7f2950f9`, one_use_id
`sql96-prod-69b5b3c5-de65-4d63-8614-65a709b70950` (spent), migration source `18109fed…` (== pin).
Every step was ok; contracts claim-ledger 4/4, tenant-isolation 6/6, financial-write-protections
43/43; manifest `ea6ea07e…`; receipt `275400ff…` -> `ea844355…`, unrelated catalog `975cfaa9…`;
post-apply inspect already_applied true, precondition_failures []. No later read-only inspect was
run. The pin is `execute: false` again; a re-apply needs a new reviewed pin change, and SQL 93
must never be re-run now. SQL 98 and SQL 102 are next in the database;
`tenant-billing-engine.mjs` / `tenant-billing-handlers.mjs` may follow in their Lambda batch.

## Production apply of SQL 94 (2026-10-19)

One owner-approved run ( + APPROVAL + ) of `production-sql-one-shot.mjs`
on `i-0c35557c4e5385406` from main `ef26f7357` (tarball `5dba0f6b…`): SSM
`d2cf26f4-f240-497a-9293-5ca70c094d68`, run_id `ca95e688-664e-43f3-97b1-9699bdab9a88`, one_use_id
`sql94-prod-a4968361-4a21-409d-9448-42ffe30f5274` (spent), migration source `ef865f65…` (== pin).
Every step was ok; contracts claim-ledger 4/4, tenant-isolation 6/6, financial-write-protections
43/43; manifest `2f2603e9…`; receipt `72411598…` -> `1cdc5032…`, unrelated catalog `1d547fe3…`;
post-apply inspect already_applied true, precondition_failures []. No later read-only inspect was
run. The pin is `execute: false` again; a re-apply needs a new reviewed pin change. The document
library Lambda members it holds (sql_before) may follow in their batch once the plan records SQL 94
verified live in its own reviewed change.

## Production apply of SQL 98 (2026-10-19)

One owner-approved run ("approve #1071 and apply SQL 98 in production") of
`production-sql-one-shot.mjs` on `i-0c35557c4e5385406` from main `ce212b5aa` (tarball
`756cf4fa…`): SSM `817865e7-2684-4f87-9f56-e57ed5386add`, run_id
`bef29dcf-c1fa-48d8-8c5f-0511b90e3403`, one_use_id `sql98-prod-5a067c1d-8c6b-44b5-b646-2f7175d7b66e`
(spent), migration source `5a42e485…` (== pin). Every step was ok; contracts claim-ledger 4/4,
tenant-isolation 6/6, financial-write-protections 43/43; manifest `a198b832…`; receipt
`d64218dc…` -> `abcb8f21…`, unrelated catalog `9b6ffc5c…`; post-apply inspect already_applied
true, precondition_failures [], every function, policy, table, column and trigger intended. The
billing counts were the same before and after (one production platform billing destination,
reviewed and verified; no sandbox rows; no duplicate billing periods or check billing events; one
active check billing config). The AWS tool call that sent the command returned an error after
SendCommand succeeded; the command was not resent, and its result (Success, exit 0) was read back
read-only with GetCommandInvocation. No later read-only inspect was run. The pin is
`execute: false` again; a re-apply needs a new reviewed pin change, and SQL 96 must never be re-run
now. The fee members (`tenant-billing-engine.mjs`, `tenant-billing-handlers.mjs`,
`workflow-rpc.mjs`, `providers.mjs`) stay held until the plan records SQL 98 verified live in its
own reviewed change; `tenant-billing-handlers.mjs` also waits for SQL 102.

## Production apply of SQL 102 (2026-10-20)

One owner-approved run ("apply SQL 102 in production") of `production-sql-one-shot.mjs` on
`i-0c35557c4e5385406` from main `be79a8199` (tarball `97d98c51…`, transfer run `39350123741`),
after a read-only `--phase inspect` from the same commit and tarball (SSM
`50bc3e42-ff4c-4200-bef6-0006007382ce`: live `d3b2cd30…`, precondition_failures []). Apply: SSM
`fdf84b2e-8f53-4e9f-b6a4-37a56054175b`, run_id `f3f1d49f-9579-4b7b-a0de-731f05250158`, one_use_id
`sql102-prod-b4d3462c-ff00-463b-86df-58b711b4e141` (spent), migration source `7ef8736b…` (== pin).
Every step was ok; contracts claim-ledger 4/4, tenant-isolation 6/6, financial-write-protections
43/43; manifest `56794491…`; receipt `d3b2cd30…` -> `6e1346af…`, unrelated catalog `ae8817ff…`;
post-apply inspect already_applied true, precondition_failures [], the five new functions,
`aws_tenants_member_column_guard()` and the `aws_tenant_profile_audit` trigger intended. The command
was sent once and its result (Success, exit 0) read back read-only with GetCommandInvocation; SSM
cut the console output off at 24,000 characters, and every recorded value comes from the part it
kept. The date is the runner's UTC date (the evening of 2026-10-19, US Eastern). No later read-only
inspect was run. The pin is `execute: false` again; a re-apply needs a new reviewed pin change, and
SQL 98 must never be re-run now. `tenant-billing-handlers.mjs` stays held until the plan records
SQL 102 verified live in its own reviewed change.

## Production applies of SQL 95 and SQL 99 (2026-10-21)

One owner approval statement, passed verbatim (base64, `--approval-statement-b64`) to each run:
"apply SQL 97, 95 and 99 in production" (the one-shot cannot verify who said it; it covered these
runs only). Both runs used `production-sql-one-shot.mjs` on `i-0c35557c4e5385406`, operator
`michaelcarletta-cmd`, from main `dcd865256` (tarball
`source-dcd86525690e0732691ab7bf0723dc25167d89e9.tar.gz`, sha256 `2c0c0fac…`, transfer run
`39624539833`, `sql53-temporary-transfer.yml` dispatched on main at 2026-10-21T15:19:15Z). In each,
every step was ok (pin, source, inspect, contracts, manifest, source-recheck-before-preflight,
preflight, evaluate, source-recheck-before-apply, apply (applied), post-apply-inspect); contracts
claim-ledger 4/4, tenant-isolation 6/6, financial-write-protections 43/43; unrelated catalog
`8a56ccd6…` (relations 890, columns 3535, constraints 2233, policies 404, functions 1310, indexes
654, triggers 178, views 25, types 18, roles 29, role memberships 15). Start and finish times were
not captured.

- **SQL 95:** SSM `2f1530c2-0cf9-42a9-8fef-685b5e83589a`, run_id
  `3b4fe182-94bd-494f-b411-af75f4f3ce92`, workstream
  `prod-sql95-remove-freedom-claims-bridge-20261021`, one_use_id
  `sql95-prod-d04849eb-31b3-4657-a622-d0ffa030207d` (spent), migration source `0cf0dafd…` (== pin);
  pre-apply inspect live `48535b69…` (live_matches_expected true, already_applied false,
  precondition_failures [], missing_dependencies [], successors_applied []); manifest `6c7551a0…`;
  receipt `48535b69…` -> `a737e4ec…`, result applied; post-apply inspect live `a737e4ec…`,
  already_applied true, precondition_failures []. Applied before SQL 97 (see step 8 and "SQL 97 not
  applied").
- **SQL 99:** SSM `fa655042-6ae1-41e6-96cc-a5b3ed61f4a8`, run_id
  `bfb0c630-87a6-46f8-819d-4155a7b54640`, workstream
  `prod-sql99-mortgage-desk-completion-messages-20261021`, one_use_id
  `sql99-prod-56ce276e-16ea-49c5-9d44-7746a5a9c673` (spent), migration source `0c079fe4…` (== pin);
  pre-apply inspect live `4d174e86…` (matches expected, predecessor sql90 applied,
  precondition_failures []); manifest `2ba74dca…`; receipt `4d174e86…` -> `481ac0f1…`, result
  applied; post-apply inspect live `481ac0f1…`, already_applied true. Whether the SPA build that
  stops the Mortgage Desk client posts (`MortgageOpsQueue.tsx`) is live was not checked here.

No later read-only inspect was run. Both pins are `execute: false` again; a re-apply needs a new
reviewed pin change. Neither file is a `sql_before` of any overlay member or listed in
`sql_prerequisites` / `staging-sql-live.json`, so no plan change follows from these applies.

## SQL 97 not applied (2026-10-21)

The same owner statement named SQL 97, but its one-shot was not run. Its pre-apply read-only
inspect (SSM `16bcba87-7ad4-48b1-a63b-a2de20d25eee`, main `dcd86525690e0732691ab7bf0723dc25167d89e9`)
reported `table_privileges` for `financial_stepup_log` with lines `["checksops INSERT"]` and
`other_write_grants` `["checksops DELETE", "checksops UPDATE"]`. By the rule in step 7 and the review
note on SQL 97's BEFORE INSERT guard (stop when `other_write_grants` is not `[]`), it stopped. The
owner decided to build SQL 106 (revoke UPDATE, DELETE and TRUNCATE on `financial_stepup_log`) to be
applied before SQL 97; that is a separate PR, in progress. SQL 97's pin has no `applied` record and
keeps `execute: true` unchanged. Its recorded pre-state `56b1f631…` is from the inspect of
2026-10-21 (SSM `43cb1d1f`); after SQL 106 the live fingerprint may differ, so a fresh read-only
inspect decides whether the pin needs a new reviewed change before any SQL 97 apply.
