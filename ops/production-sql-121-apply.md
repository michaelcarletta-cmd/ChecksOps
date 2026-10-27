# Production SQL 121 (Cash Jobs: table grants and the cash-job payment at Check Alt approval)

| key | file | what it does |
|---|---|---|
| `sql121` | `aws/workflows/sql/121_cash_jobs_production_grants.sql` (sha256 `72f1c189c4f218c477cea5f9974c40cbe1ff05b5cd4caf6f390e66636fd59ae6`) | Lets the API write cash jobs, their line items and attachments (table grants; the RLS write policies stay the boundary), makes the existing deposit-time cash-job payment trigger function run as its owner, and records a cash-job check's payment when its Check Alt deposit is approved or accepted (removed again when that deposit is then rejected and the check did not go through). |

**Why.** The owner, 2026-10-27: "Make sure cash jobs works the same as claim checks ... When a
Job is created, it will show up under All Jobs where a tenant can open the file, upload checks
from clients which will move to review to proceed with the normal process but will automatically
be linked to that particular cash job", and "yes, record cash-job payments on Check Alt approval."

- A job and its line items are written through `/data/write` as `checksops`. The restored
  database gave `checksops` SELECT only on the cash-job tables (staging has the DML grants from
  the staging-only SQL 67). PostgreSQL checks table privileges before row-level security, so the
  INSERT is refused before `aws_write_cash_jobs` is evaluated.
- `trg_sync_cash_job_check_payment` (AFTER UPDATE OF status ON `check_intake_items`) inserts the
  job's payment into `cash_job_payments` when a cash-job check becomes `deposited`. Its function
  is SECURITY INVOKER, so on AWS it runs as `checksops`, which holds no INSERT on
  `cash_job_payments` (a financial table; this file grants none): the deposit UPDATE would fail.
- A check deposited through Check Alt never becomes `deposited` (its `checkalt_deposits` row goes
  `submitted`, then `cleared`), so that trigger never fires for it and the job would show nothing
  collected.

**What it changes.**

- GRANT SELECT, INSERT, UPDATE, DELETE ON `cash_jobs`, `cash_job_line_items` and
  `cash_job_attachments` TO `checksops` and `authenticated`. No TRUNCATE, REFERENCES or TRIGGER;
  nothing to PUBLIC or anon; nothing on `cash_job_payments`. `aws_write_cash_jobs`,
  `aws_write_cash_job_line_items` and `aws_write_cash_job_attachments`
  (`aws/rls/sql/24_complete_write_policies.sql`) remain the authorization boundary.
- `sync_cash_job_check_payment()`: SECURITY DEFINER, `search_path = public, pg_temp`, every
  privilege of PUBLIC, `checksops` and `authenticated` revoked (a trigger function needs no EXECUTE
  grant to fire). Its body is unchanged; the tools refuse (`acl_functions_body_reviewed`) unless
  the live body is the reviewed one from `supabase/migrations/20260522142101_*.sql`, and roll back
  unless it is still that body afterwards.
- `aws_record_cash_job_checkalt_payment()` (new; SECURITY DEFINER, `search_path = public, pg_temp`,
  `row_security = off`, EXECUTE for the owner only) and its trigger
  `aws_checkalt_deposit_cash_job_payment` (AFTER INSERT OR UPDATE OF status ON
  `checkalt_deposits`):
  - when a deposit becomes `submitted` or `cleared` from any other status and its check is a
    cash-job check (`check_source 'cash_job'` with a `cash_job_id`), the job's payment row exactly as
    `sync_cash_job_check_payment()` writes it (the check's amount, `payment_method 'check'`,
    `reference_number` = the check id, the notes by payment class), unless a payment for that check
    already exists: once per check, whichever path records it first;
  - when that deposit then becomes `rejected`, `error` or `duplicate`, no other deposit of the
    check is `submitted` or `cleared` and the check is not `deposited`: that automatic payment
    (`reference_number` = the check id, `payment_method 'check'`) is deleted. A payment entered by
    hand (another reference) and every non-cash-job check are never touched.

Not changed: no grant on `cash_job_payments`; `sync_cash_job_check_payment()`'s body and trigger,
`sync_cash_job_total_paid()` and `sync_cash_job_status()`; no column, policy, RLS setting or row.

**One public trigger more.** Once applied, the DB validator's justified trigger set and
`EXPECTED_PUBLIC_TRIGGERS` (182 today, `aws/functions/api/db-readonly-validate.mjs`) must follow in
their own change, as #1309 did for SQL 120; not before the apply.

**Staging executor refreshed (2026-10-27).** Inspect run 40587591216 (main `d20d599`) found the live
executor at `gX5VOEw7…` without `sql/121_cash_jobs_production_grants.sql` and
`sql/122_mortgage_desk_return_to_tenant.sql`. Deploy run 40587866121 updated it to main's package
(`3k6z4Pa45EyaPoS5EuUL4U7j8DGrhWzUPp8LG6/biCE=`; "Verify live executor now carries main's package" passed).

**Staging read-live (2026-10-27).** Run 40588277757 (main `d20d599`): `aws_record_cash_job_checkalt_payment()`
and the `aws_checkalt_deposit_cash_job_payment` trigger on `checkalt_deposits` absent; `checksops`
already holding SELECT / INSERT / UPDATE / DELETE (owner-granted) on `cash_jobs`,
`cash_job_line_items` and `cash_job_attachments`, no other write grant; `sync_cash_job_check_payment()`
with the reviewed body (`body_reviewed` true) but not SECURITY DEFINER, `search_path=public` and
EXECUTE to PUBLIC and the owner (state `different`, which the file sets); every prerequisite present;
the definer writes to `cash_job_payments` and `cash_jobs` possible; live
`084deae36bb533c91124d12698b1adb29e5fa7b9ff53932aa293537bc573e76e`, `already_applied` false,
`precondition_failures` `[]`. Recorded in the staging pin (`expected_live_definition_sha256`,
`execute: true`, wave 21) under the owner's words of 2026-10-27, "start the SQL 121 and 122 staging
applies".

**Staging apply (2026-10-27).** Run 40591140684 (main `3a4fedb`, after #1316 merged the staging pin and
executor deploy run 40590824367 carried it, `7wybTiIc…`): receipt before
`084deae36bb533c91124d12698b1adb29e5fa7b9ff53932aa293537bc573e76e`, after
`2dd2ead6974cec45f2b88fc76c81a3cd48befa25cc63fe03133f9fe24593165e` (intended), result `applied`. Read-live
run 40591470594: `already_applied` true, `precondition_failures` `[]`.

**Production inspect (2026-10-27).** Read-only `--inspect` through SSM
`b76e02f3-ea93-44fd-b00c-c0b72ed74509` on `i-0c35557c4e5385406`, main `3a4fedb` (tarball sha256
`afab3a5b3242dd31dcf66bf1349c3970fa08e8c784b9cc304c4f44be6426a494`, transfer run 40590734577, migration
source `72f1c189…` == pin), connected as `checksops_admin`: the new function and its trigger absent;
`checksops` already holding SELECT / INSERT / UPDATE / DELETE on the three cash-job tables, no other write
grant; `sync_cash_job_check_payment()` with the reviewed body, not SECURITY DEFINER, EXECUTE to PUBLIC,
`checksops` and the owner; every prerequisite present; live
`ded8c0f12bdb33d0d5c7cc6d544ddddac5a87db5696d5901fb2ffcaff338a790`, `already_applied` false,
`precondition_failures` `[]`. Production differs from staging's pre-state (`084deae3…`) only by the
`checksops` EXECUTE on `sync_cash_job_check_payment()`, which the file revokes, so both end on the same
intended fingerprint. Recorded in the production pin with the staging apply as its staging acceptance and
`execute: true` under the owner's words of 2026-10-27, "Go" (approving this pin change). The owner merges
the pin change; the apply still needs the owner's run-time approval and runs only after that merge is on
main and staged.

**Status:** applied to staging (wave 21); production pin execute-authorized; not applied to production.

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec
`sql121` in `release-sql-specs.mjs`): the new function's attributes, body hash and EXECUTE ACL; the
trigger's definition; `sync_cash_job_check_payment()`'s EXECUTE ACL, SECURITY DEFINER, proconfig
and reviewed body hash (spec `acl_functions` with `attributes`); and the SELECT / INSERT / UPDATE /
DELETE lines of `checksops` and `authenticated` on the three tables. Every ACL line carries its
grantor (`render.grantors`). Intended
`2dd2ead6974cec45f2b88fc76c81a3cd48befa25cc63fe03133f9fe24593165e`:

```
release sql121 v1
function public.aws_record_cash_job_checkalt_payment(): lang=plpgsql vol=v parallel=u secdef=true result=trigger config=row_security=off;search_path=public, pg_temp prosrc=48b91d9e844f11d6fd3e20ceba405c496d521802058d1719255b4c2416251c92 acl=owner EXECUTE grantor=owner
function_acl public.sync_cash_job_check_payment(): acl=owner EXECUTE grantor=owner secdef=true config=search_path=public, pg_temp prosrc=032154c6f7c53d0e2f1e293280ba6379003c4c21d96c029eee8028775aac66de
trigger public.checkalt_deposits aws_checkalt_deposit_cash_job_payment: enabled=O def=ca85863ecfb9104a258b9201e869be7bc6ca9a78e485c5b18f85454cf0fc405a
privileges public.cash_jobs SELECT,INSERT,UPDATE,DELETE: authenticated DELETE grantor=owner;authenticated INSERT grantor=owner;authenticated SELECT grantor=owner;authenticated UPDATE grantor=owner;checksops DELETE grantor=owner;checksops INSERT grantor=owner;checksops SELECT grantor=owner;checksops UPDATE grantor=owner
privileges public.cash_job_line_items SELECT,INSERT,UPDATE,DELETE: authenticated DELETE grantor=owner;authenticated INSERT grantor=owner;authenticated SELECT grantor=owner;authenticated UPDATE grantor=owner;checksops DELETE grantor=owner;checksops INSERT grantor=owner;checksops SELECT grantor=owner;checksops UPDATE grantor=owner
privileges public.cash_job_attachments SELECT,INSERT,UPDATE,DELETE: authenticated DELETE grantor=owner;authenticated INSERT grantor=owner;authenticated SELECT grantor=owner;authenticated UPDATE grantor=owner;checksops DELETE grantor=owner;checksops INSERT grantor=owner;checksops SELECT grantor=owner;checksops UPDATE grantor=owner
```

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present` (the four cash-job tables, `check_intake_items` and its cash-job columns,
`checkalt_deposits`, `sync_cash_job_check_payment()`, the roles `checksops` and `authenticated`);
`altered_relations_owned_by_login` (the three granted tables and `checkalt_deposits`);
`functions_owned_by_login`; `function_acl_replaceable`; `acl_functions_present`,
`acl_functions_owned_by_login`, `acl_functions_acl_replaceable` (every live EXECUTE entry on
`sync_cash_job_check_payment()` is the owner's or one the file revokes: PUBLIC, `checksops`,
`authenticated`, each owner-granted) and `acl_functions_body_reviewed`;
`definer_can_write_relations` (`cash_job_payments`, `cash_jobs`).

Post-conditions: the intended fingerprint; `sync_cash_job_check_payment()` otherwise unchanged
(body, language, volatility, result, owner); every other grant on the three tables unchanged;
everything else in schema `public` (and the functions of `auth`) unchanged. The tools roll back
otherwise.

## Steps

1. Staging: the staging executor must carry SQL 121 first (executor package refresh through the
   guarded staging executor `deploy` mode, its own reviewed run). Then run the guarded staging
   SQL executor with `read-live` for `sql121-cash-jobs-grants`. If it reports
   `prerequisites_missing` other than `[]` or `precondition_failures` other than `[]`, stop.
   Otherwise record `LIVE_DEFINITION_SHA256` in the staging pin (`expected_live_definition_sha256`,
   owner-approved `authorization`, `execute: true`) in a reviewed change, `apply`, then `read-live`
   again. Test on staging: create a cash job and a line item as a tenant; upload a cash-job check
   and approve its Check Alt deposit; the job shows the payment once.
2. Production: run the read-only inspect on the runner
   (`node scripts/deployment-guard/production-sql-one-shot.mjs --migration sql121 … --phase inspect`);
   record `production_inspect` and copy `live_definition_sha256` into
   `expected_live_definition_sha256`; record the staging runs in `staging_acceptance`; set an
   owner-approved `authorization` and `execute: true`, in one reviewed change.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs
   --migration sql121 --approval-scope sql121 … --phase apply` with the owner's words.
4. Record the apply and retire the pin (`execute: false`). Then, in its own change, the DB
   validator's justified trigger set and expected count (one public trigger more).
