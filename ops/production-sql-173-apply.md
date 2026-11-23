# Production SQL 173 (job expenses: costs paid outside ChecksOps, per insurance or cash job)

| key | file | what it does |
|---|---|---|
| `sql173` | `aws/workflows/sql/173_job_expenses.sql` (sha256 `88e0ddff2b315b3e430350fc52dadaee9af1f6bab7d0981373b67bff768a3b45`, authored by `b727c13a6`) | Refuses without its prerequisites (`55000 sql173_prerequisite_missing`), unless the applying login can read `claims`, `cash_jobs` and `check_intake_items` past row security (`55000 sql173_definer_cannot_read`), or when a `job_expenses` table with other columns exists (`55000 sql173_unexpected_table`); then creates the table `job_expenses` with one tenant SELECT policy and two SECURITY DEFINER functions with EXECUTE for `checksops` only. |

**Why.** Owner 2026-11-23: "Proceed with the per job build. Make sure it is for insurance jobs and cash jobs". Step 3
of the agreed per-job design: record job costs paid outside ChecksOps (materials on a supplier account, card purchases,
permits, dumpsters, labor) against an insurance job (a `claims` row) or a cash job (a `cash_jobs` row), so per-job
profit includes them. Nothing records such a cost today (SQL 147's external disbursements are payments out of a check,
not job costs).

**What it does.**
- A new table `public.job_expenses`: `id` uuid (default `gen_random_uuid()`), `tenant_id` uuid NOT NULL, `claim_id`
  uuid (foreign key to `claims(id)`) and `cash_job_id` uuid (foreign key to `cash_jobs(id)`), exactly one of the two
  (`job_expenses_one_job`), both ON DELETE CASCADE as every claim child table in `supabase/migrations` (deleting a job
  removes its expenses instead of failing on the reference); `category` text NOT NULL (`materials`, `labor`,
  `subcontractor`, `permit`, `equipment`, `other`); `amount_cents` bigint NOT NULL, 1 to 100000000000;
  `expense_date` date NOT NULL; `paid_to` (<= 200), `paid_by` (NULL or `company_card`, `supplier_account`, `cash`,
  `check`, `ach`, `other`), `notes` (<= 2000), `receipt_path` (<= 500); `created_by`; `created_at`, `updated_at`
  (NOT NULL DEFAULT `now()`); `deleted_at`, `deleted_by` (soft delete); `idempotency_key` (NULL or 8-100 characters
  `[A-Za-z0-9_:-]`, SQL 147's rule), unique per tenant (`job_expenses_tenant_idempotency_key`, partial). Two partial
  indexes for a job's live expenses: `(tenant_id, claim_id)` and `(tenant_id, cash_job_id)` WHERE `deleted_at IS NULL`.
- RLS on (not forced). One SELECT policy, `aws_select_job_expenses` TO `authenticated`, exactly the tenant-scoped form
  of `aws/rls/sql/12_final_select_policies.sql`: `aws_is_cross_tenant_reader() OR aws_can_access_tenant(tenant_id)` (the
  tenant's members and the platform owner). No INSERT, UPDATE or DELETE policy. Every non-owner grant revoked (the
  database's default privileges for a new table included, as SQL 118 and SQL 141), then SELECT for `checksops` and
  `authenticated` only.
- Two functions (plpgsql, VOLATILE, SECURITY DEFINER, `search_path = public`, `row_security = off`, owned by the
  applying login; EXECUTE revoked from PUBLIC, `anon`, `authenticated` and `service_role`, granted to `checksops`):
  - `aws_job_expense_add(p_tenant_id uuid, p_claim_id uuid, p_cash_job_id uuid, p_category text, p_amount_cents bigint,
    p_expense_date date, p_paid_to text, p_paid_by text, p_notes text, p_receipt_path text, p_idempotency_key text,
    p_user_id uuid)` returns jsonb `{expense, duplicate}`. The caller: `p_user_id` is the signed-in user (`auth.uid()`,
    as SQL 133 and SQL 156 check a passed user id) and a member of `p_tenant_id` by SQL 90's `aws_can_write_tenant`
    (membership only, SQL 147's rule), else `42501 job_expense_forbidden`. Inputs, else `22023 job_expense_invalid:
    <what>`: exactly one job; category and `paid_by` trimmed and lower-cased, in their lists; the amount, the date, the
    text lengths (trimmed, blank is NULL) and the key's shape. The job: a cash job whose `tenant_id` is the tenant, or a
    claim of the tenant by the API's own rule (`aws/functions/api/tenant-library.mjs` `claimBelongsToTenant`:
    `claims.org_id` is the tenant, or `org_id` is NULL and one of the tenant's checks carries the claim), else `P0002
    job_expense_job_not_found` (the same answer for another tenant's job). A key already recorded for the tenant with the
    same expense returns that row with `duplicate` true and writes nothing; the key with another expense is `23505
    job_expense_key_reused` (a race on the key resolves on the unique index the same way).
  - `aws_job_expense_delete(p_tenant_id uuid, p_expense_id uuid, p_user_id uuid)` returns boolean: the same caller check;
    soft-deletes the tenant's live expense (`deleted_at`, `updated_at` now, `deleted_by`); false for an unknown id,
    another tenant's expense or one already removed.
- Idempotent: `CREATE TABLE` / `INDEX IF NOT EXISTS`, `DROP POLICY IF EXISTS` before `CREATE POLICY`, the ACL reset,
  `CREATE OR REPLACE FUNCTION`; when everything is already in place it notices `sql173_already_current`.

**Not changed:** no existing table, column, constraint, index, trigger, policy, grant, function or row. `claims`,
`cash_jobs` and `check_intake_items` are only read; the two foreign keys add only PostgreSQL's internal referential
triggers on `claims` and `cash_jobs` (as SQL 141's on `tenants`). Nothing writes or reads an expense until the API
calls the functions: its own later step (an API route through a Lambda overlay), then the website (a job's expenses and
per-job profit), each after this pin is applied in production. No API, Lambda or SPA change is part of this pin.

**Status:** tooling built; staging and production pins pending (`execute: false`). Nothing applied or read. Staging
wave 65 when approved (wave 64 is SQL 172's, also pending; wave 63, SQL 171, is the highest applied).

## Order

No predecessor in the release engine. The file needs SQL 90's `aws_can_write_tenant(uuid)` (membership only; applied in
both environments since 2026-10-19) and the AWS RLS helpers `aws_can_access_tenant(uuid)` and
`aws_is_cross_tenant_reader()` as prerequisites, and refuses with `sql173_prerequisite_missing` without them.

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec `sql173` in
`release-sql-specs.mjs`). Intended `b593bc24cefeae9f174cf1e8ba23bca7db6387f96c9dcf777ffe6358b2a4522a`:

```
release sql173 v1
function public.aws_job_expense_add(uuid, uuid, uuid, text, bigint, date, text, text, text, text, text, uuid): lang=plpgsql vol=v parallel=u secdef=true result=jsonb config=row_security=off;search_path=public prosrc=2b656c5e8bcf85c23322351aa0d6c63660c2b2aa001ded394d5fa9cc87f24e13 acl=checksops EXECUTE;owner EXECUTE
function public.aws_job_expense_delete(uuid, uuid, uuid): lang=plpgsql vol=v parallel=u secdef=true result=boolean config=row_security=off;search_path=public prosrc=ca6f38b9786579c22c7b1940faab6150a97a256775d07a37818cfcb08bff2b4d acl=checksops EXECUTE;owner EXECUTE
policy public.job_expenses aws_select_job_expenses: cmd=SELECT permissive=true roles=authenticated qual=c59d102e8d4c01d657b473808a93f48932923975af10092a79d92ee85e88565c with_check=-
table public.job_expenses: kind=r rls=true forced=false
table public.job_expenses column id: uuid notnull=true default=eea9a3e7c2abe43835e2a6fdf92a7d1e6f145ad6dfbfd243fc5d395e5b390a33 acl=
table public.job_expenses column tenant_id: uuid notnull=true default=- acl=
table public.job_expenses column claim_id: uuid notnull=false default=- acl=
table public.job_expenses column cash_job_id: uuid notnull=false default=- acl=
table public.job_expenses column category: text notnull=true default=- acl=
table public.job_expenses column amount_cents: bigint notnull=true default=- acl=
table public.job_expenses column expense_date: date notnull=true default=- acl=
table public.job_expenses column paid_to: text notnull=false default=- acl=
table public.job_expenses column paid_by: text notnull=false default=- acl=
table public.job_expenses column notes: text notnull=false default=- acl=
table public.job_expenses column receipt_path: text notnull=false default=- acl=
table public.job_expenses column created_by: uuid notnull=false default=- acl=
table public.job_expenses column created_at: timestamp with time zone notnull=true default=28a4dae0461e17af56e979c2095abfbe0bfc45fe9ca8abf3144338a518a1bb8f acl=
table public.job_expenses column updated_at: timestamp with time zone notnull=true default=28a4dae0461e17af56e979c2095abfbe0bfc45fe9ca8abf3144338a518a1bb8f acl=
table public.job_expenses column deleted_at: timestamp with time zone notnull=false default=- acl=
table public.job_expenses column deleted_by: uuid notnull=false default=- acl=
table public.job_expenses column idempotency_key: text notnull=false default=- acl=
table public.job_expenses constraint job_expenses_amount: 6c1a1377118cd7faa4904e0bf7f24c6af60fce88e38f5e2d845e4061a8ae6f1b validated=true
table public.job_expenses constraint job_expenses_cash_job_id_fkey: adcb213e7d4f65fea29c61cdbe1c610ffb64dad267c900064062f8ea463ce95f validated=true
table public.job_expenses constraint job_expenses_category: 551d024761e82343d59cd720eb8f5c86a3b252e9a88e35318ddb74502de3ebf0 validated=true
table public.job_expenses constraint job_expenses_claim_id_fkey: 8e6ceb3c09550af4b0df82a10bb271830654a3a3680515ae478a7d2f774e7102 validated=true
table public.job_expenses constraint job_expenses_idempotency_key_shape: 5832502a40617bea56dd203b8da7c41ec85ca00be0ca785d78802d085d915af3 validated=true
table public.job_expenses constraint job_expenses_one_job: a1f1299015c1f2f2f936b46122f5ff5ca0d474fd507589f6bc6210e196d36758 validated=true
table public.job_expenses constraint job_expenses_paid_by: 1350a6f689c115981ad1f4603d0b084169b5cf960fd1b2e4cd4b88463c7cdf5b validated=true
table public.job_expenses constraint job_expenses_pkey: 8c8464f42472e42ee190fc91ca8db79b5351d3a4609040516578d229c56f6fa5 validated=true
table public.job_expenses constraint job_expenses_text_lengths: 247c01cde8220004cda6c5e17d57a465aaf6bd489fad3731293525e675c30ef2 validated=true
table public.job_expenses index job_expenses_pkey: 23195cb26ab540d00109fd9caf8a46237f9f6aa464ca31b9e453091f5c77a5fd
table public.job_expenses index job_expenses_tenant_cash_job_idx: 125ef02d2bb1fa88963364f9d24d3584abccede7937f00a999eac77108627cba
table public.job_expenses index job_expenses_tenant_claim_idx: 9a93e9bdb99f32f06cc0ae756790978a8cfcd02beae070bfe8ee32cfbe39188a
table public.job_expenses index job_expenses_tenant_idempotency_key: 79f0d7d29620d6583a2b0a06d1318662e42a0baed0827e6b6b57dc351227ec29
table public.job_expenses policies: aws_select_job_expenses
table public.job_expenses triggers: 
table public.job_expenses acl: authenticated SELECT;checksops SELECT
```

**Expected pre-state (both environments).** Everything absent:

```
release sql173 v1
function public.aws_job_expense_add(uuid, uuid, uuid, text, bigint, date, text, text, text, text, text, uuid): absent
function public.aws_job_expense_delete(uuid, uuid, uuid): absent
policy public.job_expenses aws_select_job_expenses: absent
table public.job_expenses: absent
```

That is `4cc4506d60b103ff058ea7ed83009159e501ac46b03165a6dc0dc11dae8f5df2` (`releaseStateHash('sql173', {})`). Each pin
records its own environment's read; neither value is written into a pin before a run reads it. A pre-state other than
this one is a stop.

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present` (`claims`, `cash_jobs`, `check_intake_items`, `tenant_users` and the columns the functions
read, `aws_can_write_tenant(uuid)`, `aws_can_access_tenant(uuid)`, `aws_is_cross_tenant_reader()`, `auth.uid()`,
`gen_random_uuid()`, the roles `checksops` and `authenticated`); `definer_can_write_relations` on `claims`,
`cash_jobs` and `check_intake_items` (the add function reads them past row security); `created_tables_absent_or_intended`;
`functions_owned_by_login`, `function_results_match` and `function_acl_replaceable` (each function absent, or owned by
the login with the same result type and only the ACL entries the file sets).

Post-conditions: the intended fingerprint; the new table and functions owned by the login; everything else in schema
`public` unchanged. The tools roll back otherwise.

## Steps

Each step is its own reviewed PR or run and waits for the owner's words for that step.

1. Staging: the staging executor must carry SQL 173 first (executor package refresh through the guarded staging executor
   `deploy` mode, its own reviewed run). Then `read-live` for `sql173-job-expenses`. Expected `already_applied` false,
   `precondition_failures` `[]`, `prerequisites_missing` `[]`, `predecessors` `{}`, live `4cc4506d…`. Otherwise
   stop. Record `LIVE_DEFINITION_SHA256` in the staging pin (`expected_live_definition_sha256`, owner-approved
   `authorization`, `execute: true`, wave 65) in a reviewed change, `apply`, then `read-live` again.
2. Production: with the owner's OK for that read, the read-only inspect on the runner
   (`node scripts/deployment-guard/production-sql-one-shot.mjs --migration sql173 … --phase inspect`); record
   `production_inspect`, copy `live_definition_sha256` into `expected_live_definition_sha256`, record the staging runs in
   `staging_acceptance`, set an owner-approved `authorization` and `execute: true`, in one reviewed change.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs --migration sql173
   --approval-scope sql173 … --phase apply` with the owner's words (authorization phrase `RECORD_JOB_EXPENSES`).
4. Record the apply and retire the pin (`execute: false`).
5. Then the API (a route that calls `aws_job_expense_add` / `aws_job_expense_delete` with the signed-in user, and reads a
   job's live expenses) and the website (a job's expenses and per-job profit), each its own PRs and runs with the owner's
   words.

Rollback (not part of this pin; a reviewed step of its own if ever needed): drop the two functions and the table. The
recorded expenses are lost; nothing else depends on them.
