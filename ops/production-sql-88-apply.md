# Production SQL 88 (tg_claim_id_assign_case tenant scope)

`aws/workflows/sql/88_claim_id_assign_case_tenant_scope.sql` (source sha256
`57216e00…`, authored in `6e903be3b`). Owner approval to start the work: 2026-10-16
(SQL 88, modelled on SQL 87). **Status:** applied to staging (2026-10-16, guarded staging SQL
executor apply run 91, read-live run 92 `already_applied`). Production: read-only inspects
on 2026-10-16 (SSM `4b86eb75-…` before SQL 87; `4e8aa79f-…` after SQL 87)
recorded the pre-state `ef7a3e02…`, unchanged by SQL 87, with `cross_tenant_links` total 0
and `precondition_failures` `[]`. The production pin is execute-authorized (owner approved
2026-10-16, staging acceptance run 91) and waits for the owner's review and merge, then the
one-shot run. Staging had 5 existing cross-tenant links (`check_cases_claim` 1,
`homeowner_ledger_events_case` 4); the owner chose to continue, and SQL 88 does not repair them.

## The bug

`public.tg_claim_id_assign_case()` (Supabase migration `20260826125804`, lines
137-175; its ACL in `20260826125833` line 3) is the SECURITY DEFINER BEFORE INSERT OR
UPDATE OF claim_id trigger function of six tables:

| trigger | table | tenant column |
|---|---|---|
| `assign_case_on_ledger_events` | `homeowner_ledger_events` | `tenant_id` |
| `assign_case_on_ledger_tokens` | `homeowner_ledger_tokens` | `tenant_id` |
| `assign_case_on_ledger_uploads` | `homeowner_ledger_check_uploads` | `tenant_id` |
| `assign_case_on_mortgage_releases` | `mortgage_releases` | none |
| `assign_case_on_mortgage_draws` | `claim_check_mortgage_draws` | none |
| `assign_case_on_signature_requests` | `signature_requests` | none |

When `NEW.case_id` is NULL it set it to the `freedom_crm` case whose
`external_claim_id` is `NEW.claim_id`, looked up by that id alone (lines 144-148). It
never checked that the case is the row's tenant's, nor that the claim belongs to the
case's tenant, so a row could be linked to another tenant's case (for example a case
the pre-SQL 87 `resolve_check_case` created for another tenant's claim). It copies no
other data and creates no case.

## Who calls it, and SQL 87

- Only the six triggers. Nothing in the AWS API, the Lambdas or the SPA names it
  (checked by `aws/tests/sql88-claim-id-assign-case-executor.test.mjs`). Triggers do not
  need EXECUTE (PostgreSQL checks it only at CREATE TRIGGER), so revoking EXECUTE from
  the API roles takes nothing away; calling it directly as an API role is 42501.
- It does **not** call `resolve_check_case`, so SQL 87's owner-only EXECUTE on that
  helper never affected it, and SQL 87's `case_callers_unsafe` guard (any function body
  naming `resolve_check_case`) is not tripped by SQL 88's body. SQL 88 still requires the
  same owner and SECURITY DEFINER on all four case functions (`tg_claim_id_assign_case`,
  `resolve_check_case`, `tg_check_intake_assign_case`, `tg_loss_draft_assign_case`), as
  SQL 87 does for its helper and callers, so the case objects stay one owner's. SQL 88
  and SQL 87 are independent; either order works and both re-run cleanly.

## What the apply changes (plain words)

- `tg_claim_id_assign_case()` keeps `RETURNS trigger`, plpgsql, VOLATILE, SECURITY
  DEFINER and `search_path=public`, and still acts only when `NEW.case_id` is NULL and
  `NEW.claim_id` is not. It links the `freedom_crm` case for `NEW.claim_id` only when:
  - the case is the row's tenant's, for a table with a `tenant_id` column (read through
    `to_jsonb(NEW)`, so one body serves all six tables); a row whose `tenant_id` is NULL
    links nothing; and
  - the claim belongs to the case's tenant (PR #991 / SQL 87 rule): `claims.org_id` is
    that tenant, or `org_id` is NULL and one of that tenant's `check_intake_items`
    references the claim.

  Otherwise `case_id` stays NULL. It never raises (partner ingestion and other server
  writes have no user). It sets only `NEW.case_id`; it copies nothing.
- EXECUTE is revoked from `PUBLIC`, `anon`, `authenticated`, `service_role` and
  `checksops` (each where the role exists) and granted to the owner only.
- Guards, all in the first DO block, before the `CREATE OR REPLACE` (only the
  REVOKE/GRANT come after it):
  - `sql88_prerequisite_missing` (55000): `check_cases`, `claims`, `check_intake_items`,
    the six tables, the four case functions or the roles `checksops` / `authenticated`
    missing;
  - `claim_case_owner_unsafe` (55000): the four case functions must have one owner and
    all be SECURITY DEFINER; the owner must not be an API role; no API role (`checksops`,
    `authenticated`, `anon`, `service_role`) may be a member of the owner role;
  - `claim_case_callers_unsafe` (55000): no other function may name
    `tg_claim_id_assign_case` in its source, and nothing but triggers may depend on it
    (no view, rule, policy, SQL-standard function body, default or constraint).
- No table, row, trigger or policy change. Existing cross-tenant links are **not**
  repaired; they are counted (below) and need their own reviewed change.

Behaviour change to know about: as in SQL 87, an org-less claim counts as a tenant's only
once one of that tenant's checks references it; until then the row is left without a case.

## Cross-tenant link counts (`cross_tenant_links`)

The staging read-live (top-level `cross_tenant_links` and `mortgage_inspect`) and the
production `--inspect` (right after `migration` / `filename`) report **counts only**: one
aggregate `COUNT(*)` per category, each in its own savepoint with `row_security` off,
inside `BEGIN READ ONLY … ROLLBACK`. No ids, names or row data. They are informational:
they are not part of the fingerprint and never a precondition, so they do not block the
apply. Shape: `{ readable, total, categories: { <key>: <count or null> },
unreadable_categories }`; `total` is the sum of the readable categories (a row can count
in more than one category); a category is `null` and listed in `unreadable_categories`
when a table is missing or RLS would filter the read.

"Claim *c* belongs to tenant *t*" is the SQL 87 rule: `c.org_id = t`, or `c.org_id IS
NULL` and some `check_intake_items` row has `claim_id = c.id` and `tenant_id = t`.

| key | counts rows of | where |
|---|---|---|
| `check_intake_items_case` | `check_intake_items ci` joined to `check_cases cc` on `cc.id = ci.case_id` | `cc.tenant_id IS DISTINCT FROM ci.tenant_id` |
| `check_intake_items_claim` | `check_intake_items ci` joined to `claims c` on `c.id = ci.claim_id` | `ci.tenant_id` is not NULL and `c` does not belong to `ci.tenant_id` |
| `loss_draft_tracking_case` | `loss_draft_tracking l` joined to its check `ci` (`ci.id = l.check_intake_item_id`) and `check_cases cc` (`cc.id = l.case_id`) | `cc.tenant_id IS DISTINCT FROM ci.tenant_id` |
| `loss_draft_tracking_claim` | `loss_draft_tracking l` joined to its check `ci` and `claims c` (`c.id = l.claim_id`) | `ci.tenant_id` is not NULL and `c` does not belong to `ci.tenant_id` |
| `check_cases_claim` | `check_cases cc` with `external_system = 'freedom_crm'` joined to `claims c` on `c.id = cc.external_claim_id` | `c` does not belong to `cc.tenant_id` |
| `homeowner_ledger_events_case`, `homeowner_ledger_tokens_case`, `homeowner_ledger_check_uploads_case` | the table's rows `r` joined to `check_cases cc` on `cc.id = r.case_id` (and `claims c` on `c.id = r.claim_id`, if any) | `r.tenant_id IS DISTINCT FROM cc.tenant_id`, or `c` exists and does not belong to `cc.tenant_id` |
| `mortgage_releases_case`, `claim_check_mortgage_draws_case`, `signature_requests_case` | the same (no tenant column) | `c` exists and does not belong to `cc.tenant_id` |

The first five are the links the pre-SQL 87 `resolve_check_case` could have made (through
the check intake and loss draft triggers); the last six are the links this bug could have
made: exactly the links the new body would refuse. The SQL is `CROSS_TENANT_LINK_COUNTS`
in `aws/write-path/guarded-sql-executor/index.mjs`; the tests check each count on a
seeded fixture (one known link per category, total 11) and 0 on a clean one, with no ids
in any output.

## Pins

| | staging (`AUTHORIZED_SQL88_CLAIM_ID_ASSIGN_CASE_TENANT_SCOPE`) | production (`ops/deployment-guard/sql88-claim-id-assign-case-tenant-scope-production-apply.json`) |
|---|---|---|
| `expected_live_definition_sha256` | `null` (record from read-live) | `null` (record from `--inspect`) |
| `intended_replacement_sha256` | `15fbe8f5f4598ee65b24599fa7396e4e03e75daa163f5cedcc8227aa560b1d2e` | same |
| authorization / execute | n/a | `"pending"` / `false` |

The post-state hash is code-derived (`sha256(mortgageStateText('sql88',
mortgageAppliedStates('sql88')))`) and re-derived from a real PostgreSQL 16 catalog by
the executor test: the reviewed definition (`93bd9cfa…`), owned by the executor login,
SECURITY DEFINER, `search_path=public`, no non-owner EXECUTE; the other three case
functions present, SECURITY DEFINER and owned by the same role. The fingerprint does not
include the other functions' bodies, so it is the same before and after SQL 87. The
inspect labels Supabase's original body `case_original` (`b03ce50d…`) and SQL 87's helper
`tenant_scoped`.

SQL 88 reuses the SQL 84-87 engine (`MORTGAGE_MIGRATIONS.sql88`, `handleMortgageMigration`,
`scripts/deployment-guard/lib/mortgage-sql-production-apply.mjs`).

## What the inspect reports

`cross_tenant_links` (above); for `tg_claim_id_assign_case`: state, arguments, result,
SECURITY DEFINER, config, owner flags, non-owner ACL entries, definition sha256,
`matches_migration`, `body_matches_migration`; for the other three case functions:
presence, owner same as it, SECURITY DEFINER; `case_owner` (the predicted owner guard,
`case_owner_safe`, `api_roles_member_of_owner`); `other_callers` (names and counts; the
triggers are counted in `trigger_count` and allowed; any other refuses with
`other_callers_present`); `claim_triggers` (the six triggers present, enabled, calling
it); prerequisites and missing columns. The staging report has no owner names.
Production adds owner names, `proacl` with grantors and the trigger function's definition
text. The one-shot records `cross_tenant_links` first (counts only).

## Where it runs

Staging: only through `.github/workflows/guarded-staging-sql-executor.yml` (migration
choice `sql88-claim-id-assign-case-tenant-scope`). Production: only on the SQL53 runner,
as in `ops/production-sql-87-apply.md` (same RDS, pinned host and `checksops_admin`
secret, `AWS_ENDPOINT_URL_SECRETS_MANAGER` set to the VPC endpoint). Never from
GitHub-hosted runners or Lambda.

## Steps (each needs owner approval)

0. **Staging executor package.** `mode: inspect` to read the live executor `CodeSha256`,
   then `mode: deploy` with `approved_commit` and `expected_executor_code_sha256` so the
   executor carries the SQL 88 file and handler.
1. **Staging read-live (read-only):**

   ```bash
   gh workflow run guarded-staging-sql-executor.yml --ref main \
     -f mode=read-live -f migration=sql88-claim-id-assign-case-tenant-scope -f approved_commit=<main sha>
   ```

   Expect `pin_executable` false, `precondition_failures` `[]`,
   `functions.tg_claim_id_assign_case.state` `case_original`, `case_owner.case_owner_safe`
   true, `other_callers.total` 0 (`trigger_count` 6) and all six `claim_triggers` present.
   Record `cross_tenant_links` (counts only) in the pin change. Otherwise **stop**.
2. **Staging pin change (reviewed PR):** record the read-live `live_definition_sha256` in
   `AUTHORIZED_SQL88_CLAIM_ID_ASSIGN_CASE_TENANT_SCOPE.expected_live_definition_sha256`.
3. **Staging apply:** `mode: apply`, `migration: sql88-claim-id-assign-case-tenant-scope`,
   `approved_commit`, `expected_executor_code_sha256`, `expected_live_definition_sha256:
   <the recorded hash>` (pre → `15fbe8f5…`), then `read-live` (`already_applied` true;
   `cross_tenant_links` unchanged: the apply changes no rows).
4. **Transfer:** dispatch `.github/workflows/sql53-temporary-transfer.yml` on main and copy
   `TARBALL_SHA256` from its log.
5. **Production inspect (read-only)**, on the runner from the extracted tree:

   ```bash
   export AWS_ENDPOINT_URL_SECRETS_MANAGER=https://vpce-01649ea2cdb21a689-tp7fo1qj.secretsmanager.us-east-1.vpce.amazonaws.com
   node scripts/deployment-guard/sql88-claim-id-assign-case-tenant-scope-production-apply.mjs --inspect
   ```

   Expect `pre_state_recorded` false, `apply_preconditions_met` false and
   `precondition_failures` `[]`. Report `cross_tenant_links` to the owner (counts only).
   Otherwise **stop**.
6. **Production pin change (reviewed PR, owner-merged):** record the inspect (including
   `cross_tenant_links`) in `production_inspect` and copy `live_definition_sha256` into
   `expected_live_definition_sha256`; after the staging apply, record
   `staging_acceptance`, set `execute: true` and the owner's approval in `authorization`
   (it must start with `Owner approved` / `owner-approved`).
7. **Run** (one-shot, `ops/production-sql-one-shot.md`): `--migration sql88
   --approval-scope sql88`, `--phase inspect`, then `--phase apply`. One transaction,
   `lock_timeout` 5s, advisory locks `sql88_mortgage_objects` and
   `sql88_claim_case_objects_production`. Verify with `--inspect`: `already_applied`
   true, `functions.tg_claim_id_assign_case.matches_migration` true, `proacl`
   `{checksops_admin=X/checksops_admin}`.
8. **Record and retire:** a reviewed change records the evidence and sets `execute` back
   to `false`.

## Rollback (a separate owner-approved operation)

No automatic rollback. Restoring the old body would reopen the cross-tenant link; do it
only through its own reviewed change. Never drop the function: the six triggers call it.
Repairing existing cross-tenant links (the counts) is a separate, reviewed data change.
