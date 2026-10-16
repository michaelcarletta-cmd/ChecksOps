# Production SQL 87 (resolve_check_case tenant scope)

`aws/workflows/sql/87_resolve_check_case_tenant_scope.sql` (source sha256
`f046c76c…`, authored in `af84133e4`). Owner approval to start the work: 2026-10-16
("start the SQL 87 resolve_check_case fix"; Option B, an internal helper).

**Status:** applied to staging (2026-10-16, guarded staging SQL executor apply run 78); not
applied to production. The production pin is execute-authorized (step 6) and waits for the
owner's review and merge, then the one-shot run (step 7). Both pre-states are recorded,
from read-only inspects only.

## The bug

`public.resolve_check_case(uuid, uuid, uuid, text, text, text, text)` (Supabase
migration `20260826125804`, lines 1-83) is SECURITY DEFINER with EXECUTE for
`authenticated` and `service_role` and no caller check. It:

- looked up a `freedom_crm` case by `external_claim_id` alone (lines 23-30), so it
  returned another tenant's case id, and did so again after an `ON CONFLICT` on the
  global `check_cases_external_claim_uidx` (lines 73-75);
- read any `claims` row named by `_claim_id` (lines 32-34) and copied its policyholder
  name, email, phone, address, carrier, policy number, mortgage company, loan number and
  loss date into a case created for `_tenant_id` (lines 51-71).

PR #991 fixed the same scoping in the server route (`executeResolveCheckCase`,
`aws/functions/api/workflow-rpc.mjs`, accepted hash `37cab8d6…`). The route never calls
the SQL function.

## Who calls it

- The trigger functions `tg_check_intake_assign_case()` (trigger
  `assign_case_on_check_intake`, BEFORE INSERT / UPDATE OF claim_id, freedom_claim_id,
  tenant_id ON `check_intake_items`) and `tg_loss_draft_assign_case()` (trigger
  `assign_case_on_loss_draft` ON `loss_draft_tracking`), both SECURITY DEFINER. They fire
  on server writes with no `request.app_user_id` (for example
  `aws/functions/api/ingest-shared-check.mjs`, which authenticates with the bridge secret)
  and on writes by any tenant role, so the helper cannot check the caller.
- Nothing in the AWS API calls it directly. The SPA's `supabase.rpc("resolve_check_case")`
  (`src/lib/checkCases.ts`) is sent by the AWS adapter (`src/integrations/aws/client.ts`)
  to `POST /data/rpc`; `handleDataRpc` (`aws/functions/api/data.mjs`) routes
  `resolve_check_case` (in `SAFE_WRITE_RPCS`) to `executeResolveCheckCase`, which runs
  its own SQL. It is not in `READ_RPCS`, so the generic `SELECT public.<rpc>(...)` path
  refuses it. Revoking EXECUTE from `checksops` and `authenticated` takes no access away
  from the API.

## What the apply changes (plain words)

- `resolve_check_case` keeps its signature, parameter names and defaults, `RETURNS uuid`,
  plpgsql, VOLATILE, SECURITY DEFINER and `search_path=public`. Its body applies PR #991's
  claim-belongs-to-tenant rule: a claim belongs to the tenant when `claims.org_id` is the
  tenant, or `org_id` is NULL and one of the tenant's checks references it. A `_claim_id`
  must be such a claim; an `_external_claim_id` with no claims row is allowed. For a claim
  outside the tenant it links nothing and copies nothing: it finds or creates only the
  tenant's own claim-number case (no external id, no claim details), or returns NULL. Both
  `freedom_crm` lookups are filtered by tenant; a conflict with another tenant's case
  returns NULL, never that case's id. It never raises, so the triggers keep inserting.
- EXECUTE is revoked from `PUBLIC`, `anon`, `authenticated`, `service_role` and
  `checksops` (each where the role exists) and granted to the owner only.
- Guards, all in the first DO block, before the `CREATE OR REPLACE` (so a psql
  autocommit run cannot leave the new body with the old ACL; only the REVOKE/GRANT come
  after it):
  - `sql87_prerequisite_missing` (55000) when `check_cases`, `claims`,
    `check_intake_items`, `loss_draft_tracking`, the three functions or the roles
    `checksops` / `authenticated` are missing;
  - `case_owner_unsafe` (55000): the helper and both trigger functions must have the same
    owner, both trigger functions must be SECURITY DEFINER, the owner must not itself be
    an API role, and no API role (`checksops`, `authenticated`, `anon`, `service_role`;
    PUBLIC cannot be a member) may be a member of the owner role (it would inherit or SET
    ROLE to the owner's EXECUTE). The owner being a member of an API role is allowed: it
    keeps its own explicit grant, and a CREATEROLE owner is a member of the roles it
    created;
  - `case_callers_unsafe` (55000): no function other than the two trigger functions may
    name `resolve_check_case` in its source, and no view, rule, policy, SQL-standard
    function body, default or constraint may depend on it.
- No table, row, trigger or policy change.

Behaviour change to know about: an org-less claim (`org_id` NULL) counts as the tenant's
only once one of its checks already references it. On the first link (the BEFORE INSERT
or UPDATE that sets that reference) the helper therefore treats it as outside the tenant
and falls back to the claim-number case, exactly as #991's route answers
`claim_not_in_tenant` for it.

## Pins

| | staging (`AUTHORIZED_SQL87_RESOLVE_CHECK_CASE_TENANT_SCOPE`) | production (`ops/deployment-guard/sql87-resolve-check-case-tenant-scope-production-apply.json`) |
|---|---|---|
| `expected_live_definition_sha256` | `8817a4b0778237649e37a39791320edaaee570558f72171875cf550d7386b00a` (read-live) | `9f264af15a4e912d6b0aef85afbb8f17bea7f322230ddf4e8616b4fb4c19a68f` (`--inspect` of 2026-10-16, SSM `4b86eb75-5d78-483c-8899-50a7971e9d42` and `0435c387-8f9b-405d-9463-f1cc81124d36`) |
| `intended_replacement_sha256` | `794dcd33b4cd61d8fc607f8e4f84df0daaf8a655afad2c7794ecf084c3a52a30` | same |
| authorization / execute | n/a | owner approved 2026-10-16 / `true` |

The pre-states differ: production's `resolve_check_case` ACL also grants `checksops`
EXECUTE explicitly (PUBLIC EXECUTE in both). The same file bytes run in both and the
post-state is the same.

**Staging acceptance** (recorded in the production pin's `staging_acceptance`): apply run
78, `https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/38910474178`, on main
`e043cde44` with the executor package `CodeSha256`
`2SK4JxaCw/NXe4OwcsvyloYPZLU0lCPrgyPdX4UN480=` (deploy run 76, `38909978264`):
`8817a4b0…` -> `794dcd33…`, result applied. Read-live run 79 (`38910633201`):
`already_applied` true, `precondition_failures` `[]`, `resolve_check_case` intended,
`acl_entries` `[]` (owner-only EXECUTE), `case_owner_safe` true, `other_callers.total` 0.

**Production pin:** `execute: true`; `authorization` records the owner's approval of
2026-10-16 ("approve the SQL 87 production unlock and apply"; "approve the unlock PR merge
after the pin PR"): production apply of SQL 87 after the staging acceptance above. It takes
effect only when the owner reviews and merges that change, and it does not itself run or
approve a run: the apply still needs the owner's run-time approval for that workstream, a
production-sql receipt owning the pinned file, the authorization phrase and a new
`one_use_id`. `expected_live_definition_sha256` stays the recorded production pre-state
(`9f264af1…`), and the post-state, source sha256 and rules are unchanged. With a pending
authorization, `execute: false` or no staging acceptance, evaluate and apply refuse with
`PRODUCTION_APPROVAL_REQUIRED` (or `GUARD_APPLY_FORBIDDEN` for execute); the tests keep
those refusals on an explicit pending copy of the pin.

The post-state hash is code-derived (`sha256(mortgageStateText('sql87',
mortgageAppliedStates('sql87')))`) and re-derived from a real PostgreSQL 16 catalog by
`aws/tests/sql87-resolve-check-case-executor.test.mjs`: the reviewed definition
(`687fecf6…`), owned by the executor login, SECURITY DEFINER, `search_path=public`, no
non-owner EXECUTE; both trigger functions present, SECURITY DEFINER and owned by the same
role. The pre-states are not code-derived (the restored bodies, owners, ACLs and the
presence of `anon` / `service_role` may differ per environment); the inspect labels
Supabase's original bodies `case_original`.

SQL 87 reuses the SQL 84-86 engine (`MORTGAGE_MIGRATIONS.sql87`, `handleMortgageMigration`,
`scripts/deployment-guard/lib/mortgage-sql-production-apply.mjs`) because it has SQL 86's
shape; it is not a Mortgage Ops change.

## What the inspect reports

Staging read-live (`mortgage_inspect`) and the production `--inspect` report, for the
helper: state (`case_original` / `intended` / `other` / `absent`), arguments, argument
names, result, SECURITY DEFINER, config, owner flags, non-owner ACL entries, definition
sha256, `matches_migration`, `body_matches_migration`; for the two trigger functions:
presence, owner flags and SECURITY DEFINER; `case_owner` (the predicted owner guard, with
`case_owner_safe` and `api_roles_member_of_owner`); `other_callers` (names and counts of
other functions, views / rules, policies and other dependents; any refuses with
`other_callers_present`); `case_triggers` (both triggers present, enabled, calling their
functions); the prerequisites and missing columns. The staging report has no owner
names. Neither reads table rows, so neither prints PII or row ids. Production adds owner
names, `proacl` with grantors and the helper's definition text.

## Where it runs

Staging: only through `.github/workflows/guarded-staging-sql-executor.yml` (migration
choice `sql87-resolve-check-case-tenant-scope`). Production: only on the SQL53 runner, as
in `ops/production-sql-84-86-apply.md` (same RDS, pinned host and `checksops_admin`
secret, `AWS_ENDPOINT_URL_SECRETS_MANAGER` set to the VPC endpoint). Never from
GitHub-hosted runners or Lambda.

## Steps (each needs owner approval)

0. **Staging executor package.** `mode: inspect` to read the live executor `CodeSha256`,
   then `mode: deploy` with `approved_commit` and `expected_executor_code_sha256` so the
   executor carries the SQL 87 file and handler.
1. **Staging read-live (read-only):**

   ```bash
   gh workflow run guarded-staging-sql-executor.yml --ref main \
     -f mode=read-live -f migration=sql87-resolve-check-case-tenant-scope -f approved_commit=<main sha>
   ```

   Expect `pin_executable` false, `precondition_failures` `[]`,
   `functions.resolve_check_case.state` `case_original`, `case_owner.case_owner_safe`
   true, `other_callers.total` 0 and both `case_triggers` present. Otherwise **stop**.
2. **Staging pin change (reviewed PR):** record the read-live `live_definition_sha256` in
   `AUTHORIZED_SQL87_RESOLVE_CHECK_CASE_TENANT_SCOPE.expected_live_definition_sha256`.
3. **Staging apply** (done 2026-10-16: apply run 78, read-live run 79; see Staging
   acceptance above): `mode: apply`, `migration: sql87-resolve-check-case-tenant-scope`,
   `approved_commit`, `expected_executor_code_sha256`, `expected_live_definition_sha256:
   <the recorded hash>` (pre → `794dcd33…`), then `read-live` (`already_applied` true).
   Then check a staging check intake insert still gets a case.
4. **Transfer:** dispatch `.github/workflows/sql53-temporary-transfer.yml` on main and copy
   `TARBALL_SHA256` from its log.
5. **Production inspect (read-only)** (done 2026-10-16, recorded in `production_inspect`), on the runner from the extracted tree:

   ```bash
   export AWS_ENDPOINT_URL_SECRETS_MANAGER=https://vpce-01649ea2cdb21a689-tp7fo1qj.secretsmanager.us-east-1.vpce.amazonaws.com
   node scripts/deployment-guard/sql87-resolve-check-case-tenant-scope-production-apply.mjs --inspect
   ```

   Expect `pre_state_recorded` false, `apply_preconditions_met` false and
   `precondition_failures` `[]`. Otherwise **stop**.
6. **Production pin change (reviewed PR, owner-merged).** First change (done): the
   inspect recorded in `production_inspect` and `live_definition_sha256` copied into
   `expected_live_definition_sha256`. Second change (done 2026-10-16, after the staging
   apply run 78): the staging apply run recorded in `staging_acceptance` (`ok: true`,
   `reference`, `basis`), `execute: true` and the owner's approval in `authorization` (it
   must start with `Owner approved` / `owner-approved`; `"pending"` refuses even with
   `execute: true`). No fresh production `--inspect` was run for that change: the
   `--phase inspect` of step 7 is that fresh inspect, and it must report the same
   `live_definition_sha256` and `precondition_failures` `[]` (the one-shot and the tool
   refuse otherwise).
7. **Run** (one-shot, `ops/production-sql-one-shot.md`): `--migration sql87
   --approval-scope sql87`, `--phase inspect`, then `--phase apply`. One transaction,
   `lock_timeout` 5s, advisory locks `sql87_mortgage_objects` and
   `sql87_check_case_objects_production`. Verify with `--inspect`: `already_applied`
   true, `functions.resolve_check_case.matches_migration` true, `proacl`
   `{checksops_admin=X/checksops_admin}`.
8. **Record and retire:** a reviewed change records the evidence and sets `execute` back
   to `false`.

## Rollback (a separate owner-approved operation)

No automatic rollback. Re-granting EXECUTE or restoring the old body would reopen the
cross-tenant read; do it only through its own reviewed change. Never drop the function:
both case triggers call it.
