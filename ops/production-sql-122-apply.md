# Production SQL 122 (the Mortgage Desk returns its work to the tenant)

| key | file | what it does |
|---|---|---|
| `sql122` | `aws/workflows/sql/122_mortgage_desk_return_to_tenant.sql` (sha256 `b6f16b1dc615a78dfff87e488c543be72d79a8d2431246b2b0db0d0dbfbc12a8`) | Lets the assigned mortgage agent (or the platform owner) put the Desk's messages, documents and shipping details on the tenant's check and request through server functions that check the caller themselves, posts the homeowner timeline row on completion, and claims the tenant's "work returned" email once per request. |

**Why.** The owner, 2026-10-27: "Need to make sure when the mortgage desk is done with their work,
it gets sent back to the tenant, with all the proper notes and documentation." The owner chose the
full fix: Desk uploads and messages go through a server path that checks the agent works that
request; the tenant sees every Desk note and document on the check; the tenant gets an email when
the work is returned.

On AWS a Mortgage Agent is not a member of the requesting tenant, so today:

- `check_messages` inserts are refused (members only; SQL 90 / SQL 99 owner decision: no agent
  policy on `check_messages`): the Desk's "update sent to tenant" messages, upload notices and
  mid-work notes never reach the tenant;
- `check_files` inserts are refused (members and the platform owner only): documents the Desk
  uploads never appear on the tenant's check;
- the shipping, mail-to and sent / received date columns of `mortgage_handling_requests` are not
  writable by the agent (SQL 100 grants UPDATE on `accepted_at`, `assigned_employee_id` and
  `completed_at` only), so the shipping card stays empty;
- the "Mortgage company step complete" homeowner timeline row is refused
  (`homeowner_ledger_events` is tenant scoped).

**What it changes.** Same approach as SQL 99 and SQL 111: no policy and no table grant; SECURITY
DEFINER functions (`search_path = public`, owned by the applying login, no `row_security`
setting, so SQL 99's mirror triggers keep running as today) that check the caller themselves.

- `mortgage_handling_requests.return_emailed_at timestamptz` (new, nullable, no default, no grant):
  when the request's "work returned" email was claimed.
- `aws_mortgage_desk_working_request(uuid, text[])` (internal; EXECUTE for the owner only): locks
  the request and returns it when the caller is the platform owner, or its assigned agent holding
  the `mortgage_agent` role (SQL 100's `aws_is_mortgage_ops_agent()`), and its status is one of
  those given and it has a check. Otherwise 42501 (`not_authorized`, `not_assigned_to_you`,
  `request_not_in_status`) or 22023 (`request_has_no_check`). The tenant always comes from the
  request row.
- EXECUTE for `checksops` (the API login) and the owner only, each through the check above:
  - `aws_mortgage_desk_post_message(uuid, text)` (in progress): one `check_messages` row on the
    request's check, 1 to 5000 characters;
  - `aws_mortgage_desk_attach_file(uuid, text, text, text, bigint, text, text)` (in progress): one
    `check_files` row (source `mortgage_ops`) for a path exactly `checks/<the request's
    check>/mortgage-ops/<file name>`; a retry returns the existing row;
  - `aws_mortgage_desk_update_shipping(uuid, jsonb)` (in progress): the listed mail-to, shipping
    label and sent / received date columns only; a label path must be a Desk document of the check;
  - `aws_mortgage_desk_completion_timeline(uuid)` (completed): one `mortgage_update` homeowner
    timeline row per request, no amount;
  - `aws_mortgage_desk_return_email_claim(uuid)` (completed): sets `return_emailed_at` once and
    returns the recipients (the requester while a member, else the tenant's members, at most 25,
    else the tenant's company email) and the email's contents (the Desk note, the Desk documents).

Not changed: no policy, RLS setting or table grant; no existing function, trigger, row or column.
Agents still cannot insert into `check_messages`, `check_files` or `homeowner_ledger_events`, or
update `mortgage_handling_requests`, directly. SQL 99's completion trigger is unchanged. No trigger
is added, so the DB validator's public trigger count is not concerned.

**Staging executor refreshed (2026-10-27).** Inspect run 40587591216 (main `d20d599`) found the live
executor at `gX5VOEw7…` without `sql/121_cash_jobs_production_grants.sql` and
`sql/122_mortgage_desk_return_to_tenant.sql`. Deploy run 40587866121 updated it to main's package
(`3k6z4Pa45EyaPoS5EuUL4U7j8DGrhWzUPp8LG6/biCE=`; "Verify live executor now carries main's package" passed).

**Staging read-live (2026-10-27).** Run 40588288300 (main `d20d599`): the six functions and
`mortgage_handling_requests.return_emailed_at` absent, every prerequisite present (SQL 100's agent
helper among them), the definer writes to `check_messages`, `check_files`,
`mortgage_handling_requests` and `homeowner_ledger_events` possible; live
`e13856d7a75483b5785b6e791fd83fbe9da9a1b09f6c819480cee54388a62609`, `already_applied` false,
`precondition_failures` `[]`. Recorded in the staging pin (`expected_live_definition_sha256`,
`execute: true`, wave 21) under the owner's words of 2026-10-27, "start the SQL 121 and 122 staging
applies".

**Staging apply (2026-10-27).** Run 40591701699 (main `3a4fedb`, after #1316 merged the staging pin and
executor deploy run 40590824367 carried it, `7wybTiIc…`): receipt before
`e13856d7a75483b5785b6e791fd83fbe9da9a1b09f6c819480cee54388a62609`, after
`d026eb9b5974a381900f2ef22066b9e408ffef86233195e14e5cdbd7ea619fe9` (intended), result `applied`. Read-live
run 40591941446: `already_applied` true, `precondition_failures` `[]`.

**Production inspect (2026-10-27).** Read-only `--inspect` through SSM
`d21ea074-cf7e-46c6-97e1-bfdf205565af` on `i-0c35557c4e5385406`, main `43a8db2` (tarball sha256
`6c6e6bd7d3afbfc5068457dce15ac4d8fc6cad9cec2b1d50f42e45dd725cbcc2`, transfer run 40608155909, migration
source `b6f16b1d…` == pin), connected as `checksops_admin`: the six functions and
`mortgage_handling_requests.return_emailed_at` absent; every prerequisite present; the definer can write
`check_messages`, `check_files`, `mortgage_handling_requests` and `homeowner_ledger_events`; live
`e13856d7a75483b5785b6e791fd83fbe9da9a1b09f6c819480cee54388a62609`, `already_applied` false,
`precondition_failures` `[]`, the same pre-state as staging's. Recorded in the production pin with the
staging apply as its staging acceptance and `execute: true` under the owner's words of 2026-10-27, "then
start the SQL 122 pin PR". The owner merges the pin change; the apply still needs the owner's run-time
approval and runs only after that merge is on main and staged.

**Status:** applied to staging (wave 21); production pin execute-authorized; not applied to production. The API
(`aws/functions/api/mortgage-desk-return.mjs`, `workflow-rpc.mjs`, `storage-write-auth.mjs`,
`app-services.mjs`) and SPA change that call these functions is a separate, later step after SQL
122 is live in staging; until then nothing calls them.

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec
`sql122` in `release-sql-specs.mjs`): each function's language, volatility, SECURITY DEFINER,
result (the four row-type results as `pg_get_function_result` prints them, `public.<table>`),
proconfig, body hash and EXECUTE ACL, and the added column's type, nullability, default and column
ACL. Intended `d026eb9b5974a381900f2ef22066b9e408ffef86233195e14e5cdbd7ea619fe9`:

```
release sql122 v1
function public.aws_mortgage_desk_working_request(uuid, text[]): lang=plpgsql vol=v parallel=u secdef=true result=public.mortgage_handling_requests config=search_path=public prosrc=731fe44d9c22cbc7ecf7d54eb428a4148477ccfa2fc98af9025396e8d989cf22 acl=owner EXECUTE
function public.aws_mortgage_desk_post_message(uuid, text): lang=plpgsql vol=v parallel=u secdef=true result=public.check_messages config=search_path=public prosrc=73049e49474db962c592889b16b024c000213d60f30fd4fda95e459aa38b3058 acl=checksops EXECUTE;owner EXECUTE
function public.aws_mortgage_desk_attach_file(uuid, text, text, text, bigint, text, text): lang=plpgsql vol=v parallel=u secdef=true result=public.check_files config=search_path=public prosrc=fe808bf4a08ae9adc9a735e0933cdd21150bea151f6d743d58d7cd4e753da9b0 acl=checksops EXECUTE;owner EXECUTE
function public.aws_mortgage_desk_update_shipping(uuid, jsonb): lang=plpgsql vol=v parallel=u secdef=true result=public.mortgage_handling_requests config=search_path=public prosrc=c5deef999b52ed07fc78c803f42998b2ead45bcadc979f61cd682666bebf2dde acl=checksops EXECUTE;owner EXECUTE
function public.aws_mortgage_desk_completion_timeline(uuid): lang=plpgsql vol=v parallel=u secdef=true result=uuid config=search_path=public prosrc=a496e320849f15044b2fdfaabde4258f909273ad6d92f38e2c34971744a76f6e acl=checksops EXECUTE;owner EXECUTE
function public.aws_mortgage_desk_return_email_claim(uuid): lang=plpgsql vol=v parallel=u secdef=true result=jsonb config=search_path=public prosrc=99a45540c20a270235e691fcfc08e95c659c2ca6d35a214da6a0de38b1e0bdcf acl=checksops EXECUTE;owner EXECUTE
column public.mortgage_handling_requests.return_emailed_at: timestamp with time zone notnull=false default=- acl=
```

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present` (SQL 100's `aws_is_mortgage_ops_agent()`, `is_platform_owner()`,
`auth.uid()`, the role `checksops`, and `check_messages`, `check_files`, `check_intake_items`,
`mortgage_handling_requests`, `homeowner_ledger_events`, `tenants`, `tenant_users` and
`identity_accounts` with every column the file's own prerequisite check names);
`altered_relations_owned_by_login` (`mortgage_handling_requests`); `functions_owned_by_login`,
`function_results_match` and `function_acl_replaceable` (a function that already exists holds only
EXECUTE entries the file keeps or revokes); `added_columns_absent_or_intended`
(`return_emailed_at` absent, or already the intended timestamptz with no grant);
`definer_can_write_relations` (`check_messages`, `check_files`, `mortgage_handling_requests`,
`homeowner_ledger_events`: owned by the login without FORCE ROW LEVEL SECURITY). The file itself
also refuses (55000 `sql122_prerequisite_missing`, `sql122_definer_cannot_write`).

Post-conditions: the intended fingerprint; every function owned by the login; the owner of
`mortgage_handling_requests` unchanged; everything else in schema `public` (and the functions of
`auth`) unchanged. The tools roll back otherwise.

## Steps

1. Staging: the staging executor must carry SQL 122 first (executor package refresh through the
   guarded staging executor `deploy` mode, its own reviewed run). Then run the guarded staging
   SQL executor with `read-live` for `sql122-mortgage-desk-return-to-tenant`. If it reports
   `prerequisites_missing` other than `[]` or `precondition_failures` other than `[]`, stop.
   Otherwise record `LIVE_DEFINITION_SHA256` in the staging pin (`expected_live_definition_sha256`,
   owner-approved `authorization`, `execute: true`) in a reviewed change, `apply`, then `read-live`
   again. The API and SPA change that calls the functions follows in its own reviewed step; test
   the Desk return on staging then.
2. Production: run the read-only inspect on the runner
   (`node scripts/deployment-guard/production-sql-one-shot.mjs --migration sql122 … --phase inspect`);
   record `production_inspect` and copy `live_definition_sha256` into
   `expected_live_definition_sha256`; record the staging runs in `staging_acceptance`; set an
   owner-approved `authorization` and `execute: true`, in one reviewed change.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs
   --migration sql122 --approval-scope sql122 … --phase apply` with the owner's words.
4. Record the apply and retire the pin (`execute: false`).
