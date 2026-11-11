# Production SQL 156 (the Mortgage Desk sees every check tenant's auto-shared library documents)

| key | file | what it does |
|---|---|---|
| `sql156` | `aws/workflows/sql/156_mortgage_desk_shared_check_library_documents.sql` (sha256 `e30e20d5d65902403426dbaf11a9467818eeb0151b90a162199687de0d2a4557`, authored by `c9bbd8379`) | Refuses without its prerequisites (`55000 sql156_prerequisite_missing`) or unless the applying login can read `mortgage_handling_requests`, `shared_checks`, `tenant_documents` and `tenants` past RLS (`55000 sql156_definer_cannot_read`); then two new SECURITY DEFINER functions, EXECUTE `checksops` and the owner only. |

**Why.** Owner 2026-11-11: "if a tenant uploads a check and shares the check with a partner, both the tenant and that partner's documents that are automatically shared with the mortgage team show up for the mortgage team", "It should be everybody shared on that check". Today only the requesting
tenant's auto-shared documents reach a Desk request (`share_library_docs_to_mortgage_request()`, aws/rls/sql 29, copies
`NEW.tenant_id`'s at creation), and `aws_mortgage_agent_can_read_library_path` refuses a file whose tenant is not the
request's tenant. SQL 156 (#1786) adds the two read functions the Desk needs to show and open every check tenant's.

**What it does.**
- `aws_mortgage_desk_shared_library_documents(uuid)` (plpgsql, STABLE, RETURNS TABLE): the `auto_share_mortgage_ops`
  `library:mortgage:%` `tenant_documents` of every tenant on the request's check (its own tenant first, then the source and
  target of every `shared_checks` row for the check with `revoked_at IS NULL`, by tenant name), at most 500, read live: a
  partner who turns auto-share on later appears, a revoked partner disappears.
- `aws_mortgage_agent_can_read_shared_library_path(text[], text, uuid)` (sql, STABLE, RETURNS boolean): the same rule for
  opening one of those files.
- Both answer the platform owner, or a signed-in mortgage agent while the request is open (`requested`, `in_progress`) or
  assigned to them (the rule `aws_mortgage_agent_can_read_library_path` already uses); anyone else is `42501
  not_authorized` (list) or false (path).

Not changed: no existing function is replaced; no table, column, policy, table grant, trigger or row. The
db-readonly-validate trigger count is not affected. No API, Lambda or SPA change is part of this pin: the API (a Desk list
action and the storage signer consulting the new path check) and the Desk page ship afterwards through their own guarded
paths.

**Staging apply (2026-11-11).** After the staging pin (#1789) and executor deploy run 43113284610 (main `830cc142c`): read-live
run 43114397318 `44259316…`, apply run 43114784372 under the owner's words "apply SQL 156 in staging" (receipt `44259316…` →
`5f40695d…`, result `applied`), read-live run 43115143552 `already_applied` true. (An earlier attempt stopped before any database
call: read-live run 43112542748 was refused because main moved under the run, #1790.)

**Production inspect (2026-11-11).** Read-only, under the owner's words "run the read-only SQL 156 production inspect": transfer run
43115925963 staged main `830cc142c` (tarball `4f284e7f…`, the SQL 156 file on the runner `e30e20d5…` == the pin), SSM
`c2003f73-ac62-4706-888f-cbc4dea08a27` on the runner (started 22:58:13Z, stopped 22:58:55Z): live `44259316…` (both functions absent), `already_applied`
false, `precondition_failures` `[]`, `prerequisites_missing` `[]`, `definer_writes` ok on all four relations.

**Production apply (2026-11-11).** After the pin change (#1791, merged to main as `e75dc0170` on the owner's words "record the SQL 156 production pin, merge it when green, and apply SQL 156 in production"), transfer run 43117354712 staged main `e75dc0170` (tarball `2c9ab989…`). Under those words (passed verbatim), a one-shot `--phase inspect` (SSM `6e3e6cc2-cfef-43a8-8851-f14e1bfc9453`, EXIT=0, nothing written) read live `44259316…` (the pinned pre-state, `live_matches_expected` true, `precondition_failures` `[]`); then one-shot `--phase apply` run `f0c507b1-1faa-4dab-a9c5-10081449934c` through SSM `0554bc94-f383-4aee-a024-24f4458a00f3`, workstream `prod-sql156-mortgage-desk-shared-check-library-20261111`, one_use_id `sql156-prod-1fa3128a-6a6d-4f48-9570-79fc0f4b2876`: contracts 4/4, 6/6 and 43/43; all 11 steps ok; manifest `9475eea6…`; receipt `44259316…` → `5f40695d3083262c2914d8330877dd6389d7c2c9263ab13f85762476e5dd55bc` (intended), result `applied`; post-apply inspect `already_applied` true, both functions `intended`, EXECUTE `checksops` and the owner. The run's JSON arrived whole (printed compact). The runner `i-0c35557c4e5385406` was started for this work at 23:09:02Z and stopped at 23:10:18Z. Nothing uses the functions until the API and the Desk page ship through their own guarded paths. Production acceptance had not been reported by the owner when this record was written; this record does not claim it.

**Status:** applied to staging (wave 48) and to production (2026-11-11); the production pin is retired (`execute: false`).

**Staging read-live (2026-11-11).** Run 43107339208 (job 130813991426, main `79e55a79a`, after executor deploy run
43106587111, inspect runs 43106173690 and 43107000432), under the owner's words "Redeploy the staging executor and run
SQL 156 read-live": `already_applied` false, `precondition_failures` `[]`, `prerequisites_missing` `[]`, `definer_writes`
`mortgage_handling_requests`, `shared_checks`, `tenant_documents` and `tenants` `ok true`; both functions `absent`. Live
`44259316206f9f591ce8f3a6d63b8627add30153669f612acf539e3eec6cda12`, equal to the derived state; intended `5f40695d…`. Recorded in the staging pin
(`expected_live_definition_sha256`, `execute: true`, wave 48) under the owner's words of 2026-11-11, "Record the SQL 156
staging pin and merge it when green, then apply SQL 156 in staging". The staging apply is a separate run after this pin is
merged and the executor is redeployed carrying it. The production pin stays pending.

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec `sql156` in
`release-sql-specs.mjs`). Intended `5f40695d3083262c2914d8330877dd6389d7c2c9263ab13f85762476e5dd55bc`:

```
release sql156 v1
function public.aws_mortgage_desk_shared_library_documents(uuid): lang=plpgsql vol=s parallel=u secdef=true result=TABLE(tenant_id uuid, tenant_name text, requesting_tenant boolean, tenant_document_id uuid, doc_type text, file_name text, file_path text, mime_type text, file_size bigint, created_at timestamp with time zone) config=row_security=off;search_path=public prosrc=b093ca2e88da76dba9468eff8cfa2892e64c8fd6f5eb4e08a6b94e29b21591a9 acl=checksops EXECUTE;owner EXECUTE
function public.aws_mortgage_agent_can_read_shared_library_path(text[], text, uuid): lang=sql vol=s parallel=u secdef=true result=boolean config=row_security=off;search_path=public prosrc=753d38bea4921f83b677d89a29d9929e11492e59939cdbd3f48e8885e61ac825 acl=checksops EXECUTE;owner EXECUTE
```

**Expected pre-state (both environments).** Both functions absent:

```
release sql156 v1
function public.aws_mortgage_desk_shared_library_documents(uuid): absent
function public.aws_mortgage_agent_can_read_shared_library_path(text[], text, uuid): absent
```

That is `44259316206f9f591ce8f3a6d63b8627add30153669f612acf539e3eec6cda12` (`releaseStateHash('sql156', {})`). Each pin records its own environment's read; neither value is written
into a pin before a run reads it. A pre-state other than this one is a stop.

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present`; `function_acl_replaceable` and `function_results_match` (where present); `definer_can_write_relations`
on `mortgage_handling_requests`, `shared_checks`, `tenant_documents` and `tenants` (the functions run with
`row_security=off`).

Post-conditions: the intended fingerprint; everything else in schema `public` unchanged. The tools roll back otherwise.

## Steps

Each step is its own reviewed PR or run and waits for the owner's words for that step.

1. Staging: the staging executor must carry SQL 156 first (executor package refresh through the guarded staging executor
   `deploy` mode, its own reviewed run). Then `read-live` for `sql156-mortgage-desk-shared-check-library`. Expected
   `already_applied` false, `precondition_failures` `[]`, `prerequisites_missing` `[]`, live `44259316…`. Otherwise stop.
   Record `LIVE_DEFINITION_SHA256` in the staging pin (`expected_live_definition_sha256`, owner-approved `authorization`,
   `execute: true`) in a reviewed change, `apply`, then `read-live` again.
2. Production: with the owner's OK for that read, the read-only inspect on the runner
   (`node scripts/deployment-guard/production-sql-one-shot.mjs --migration sql156 … --phase inspect`); record
   `production_inspect`, copy `live_definition_sha256` into `expected_live_definition_sha256`, record the staging runs in
   `staging_acceptance`, set an owner-approved `authorization` and `execute: true`, in one reviewed change.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs --migration sql156
   --approval-scope sql156 … --phase apply` with the owner's words (authorization phrase
   `SHARE_CHECK_LIBRARY_WITH_MORTGAGE_DESK`).
4. Record the apply and retire the pin (`execute: false`).
5. Then the API and the Desk page through the guarded Lambda overlay and SPA paths, each with its own approval.

Rollback (not part of this pin; a reviewed step of its own if ever needed): drop the two functions.
