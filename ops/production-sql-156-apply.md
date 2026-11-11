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

**Status:** tooling built; staging and production pins pending (`execute: false`). Nothing applied or read.

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
