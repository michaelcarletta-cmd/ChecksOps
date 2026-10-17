# Production SQL 90 to SQL 97 (release 2026-10-17)

Guarded apply tooling for the eight release 2026-10-17 migrations in `aws/workflows/sql/`.
This runbook covers staging and production and the order between them. It authorizes
nothing: every pin below is `execute: false`, `authorization: "pending"`, with no recorded
pre-state and no staging acceptance, so every apply refuses before connecting.

| key | file (sha256) | what it does | predecessors |
|---|---|---|---|
| `sql90` | `90_users_only_tenant_roles.sql` (`1ee9c1d1…`) | Users only, no tenant role tiers: `aws_is_tenant_member(uuid)` and the membership-rule helpers; `aws_can_write_tenant/check/claim`, tax-profile access, the SQL 35 manager helper and view, SQL 29's `aws_can_manage_mortgage_library` and SQL 80's Auto-Deposit save replaced; members-only write policies; platform-owner-only tenant create, first invite (`aws_first_invite_allowed`, `aws_invite_create_user_identity`) and `user_roles` writes. | SQL 29, SQL 30 |
| `sql91` | `91_moov_onboarding.sql` (`199bfa1a…`) | Four tenant-scoped Moov onboarding tables with RLS, their writer helpers and policies, onboarding / webhook policies on the payment tables, `payment_provider_methods.routing_last_four`. | — |
| `sql92` | `92_signature_request_check_files_link_grant.sql` (`ceef6482…`) | `UPDATE (signature_request_id)` on `check_files` for `checksops` and `authenticated`. | — |
| `sql93` | `93_tenant_company_info.sql` (`d90ec7f9…`) | `company_address`, `company_phone`, `company_email`, `letterhead_url` on `tenants`; the `aws_tenants_member_column_guard` BEFORE UPDATE trigger; drops the draft `aws_member_update_tenant_branding` policy. | SQL 90 |
| `sql94` | `94_document_library_restore.sql` (`ef865f65…`) | The Document Library `doc_type` rule and CHECK, `homeowner_shared_documents` (guard trigger, RLS, policies), the public homeowner share readers. | SQL 29, SQL 90 (SQL 30 optional) |
| `sql95` | `95_remove_freedom_claims_bridge.sql` (`0cf0dafd…`) | Drops `trg_notify_freedom_status_change`, `notify_freedom_status_change()`, `list_checks_by_freedom_claim(text, uuid)`, `aws_ingest_shared_check(jsonb)`, `vault_create_bridge_secret(text)`, `vault_update_bridge_secret(text)`. | — (Lambda gate, below) |
| `sql96` | `96_platform_owner_tenant_pricing.sql` (`18109fed…`) | `tenant_pricing_audit` and its trigger, `aws_platform_owner_set_tenant_pricing(uuid, jsonb)`, the replaced `aws_tenants_member_column_guard()`, platform-owner-only `platform_fee_schedules` writes. | SQL 93 |
| `sql97` | `97_financial_stepup_log_server_writer.sql` (`e3c8fd41…`) | `INSERT` on `financial_stepup_log` revoked from PUBLIC and `authenticated`, granted to `checksops`; the `aws_financial_stepup_log_writer_guard` BEFORE INSERT trigger. | — (Lambda gate, below) |

## Tooling

| piece | where |
|---|---|
| Engine (state reader, fingerprints, predecessor rules, pre/post conditions, unrelated snapshot) | `scripts/deployment-guard/lib/release-sql-state.mjs` |
| Specs (objects, reviewed ACLs, PostgreSQL renderings) | `scripts/deployment-guard/lib/release-sql-specs.mjs` |
| Staging pins (`AUTHORIZED_SQL9x_*`, `RELEASE_2026_10_17_PENDING_SQL_PINS`) | `scripts/deployment-guard/lib/sql-executor-auth.mjs` |
| Staging executor handler | `handleReleaseSqlMigration` in `aws/write-path/guarded-sql-executor/index.mjs` |
| Staging workflow choices | `.github/workflows/guarded-staging-sql-executor.yml`: `sql90-users-only-tenant-roles`, `sql91-moov-onboarding`, `sql92-signature-request-check-files-link-grant`, `sql93-tenant-company-info`, `sql94-document-library-restore`, `sql95-remove-freedom-claims-bridge`, `sql96-platform-owner-tenant-pricing`, `sql97-financial-stepup-log-server-writer` |
| Production tools | `scripts/deployment-guard/sql9x-*-production-apply.mjs` (one per key) on `lib/release-sql-production-apply.mjs` and `lib/release-sql-production-cli.mjs` |
| Production pins | `ops/deployment-guard/sql9x-*-production-apply.json` |
| One-shot | `production-sql-one-shot.mjs --migration sql90` … `sql97` (`ops/production-sql-one-shot.md`) |
| Tests | `aws/tests/release-sql90-97-executor.test.mjs`, `aws/tests/release-sql90-97-production-apply.test.mjs` (PostgreSQL 16: `sudo -n -u ubuntu env PATH=$PATH node --test …`), fixture `aws/tests/helpers/release-sql-pg.mjs` |

## Apply order

Staging first for every step, with a staging acceptance reference recorded in the
production pin before the matching production step (deltas report
`ops/release-2026-10-17-lock-pin-deltas.md` §5):

1. Deploy main's guarded SQL executor package (it carries the SQL 29/30 and SQL 90-97
   handlers and the files) through its reviewed path (`mode: deploy`).
2. **SQL 29 → SQL 30** (`ops/production-sql-29-30-apply.md`).
3. **SQL 90**, then right away the step-6 Lambdas (invites break between SQL 90 and the new
   `tenant-admin.mjs`); SQL 90 also goes before `tenant-admin.mjs` / `workflow-rpc.mjs`.
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

Exact order used by the tests: 29 → 30 → 90 → 91 → 92 → 93 → 94 → 96 → 97 → 95. The engine
enforces the database-visible part (predecessors, prerequisites, SQL 93 after SQL 96). It
cannot see Lambda state: the SQL 95 and SQL 97 gates are the operator's to check (the
deployed member SHA-256s from `guarded-staging-lambda-overlay.yml` / the production overlay
inspect) and to record in the pin change that sets `execute: true`.

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

Staging is PostgreSQL 18; the tests run PostgreSQL 16. The renderings are collapsed to
single spaces to absorb pretty-print differences. If a staging read-live after apply reports
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
  fingerprint (or, once superseded, its successor's: SQL 93 by SQL 96).
- `successors_not_applied`: SQL 93 refuses once `aws_platform_owner_set_tenant_pricing` exists.
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
`counts.rows_outside_sql94_rule`. No ids, owner names, definitions, emails or row data.

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

## Later migrations (SQL 98, SQL 99)

Adding one means: its spec in `release-sql-specs.mjs`, its staging pin (with its code-derived
`intended_replacement_sha256`) in the release pin map of `sql-executor-auth.mjs`, its file in
`EXECUTOR_PACK_MEMBERS`, its workflow choice, its production pin and a thin
`scripts/deployment-guard/sql9x-…-production-apply.mjs`. The engine, the executor handler,
the production library and CLI, and the one-shot registration are generic.
