# Production SQL 123 (Check Alt: a deposit moves its check to Deposited, a later rejection to Returned)

| key | file | what it does |
|---|---|---|
| `sql123` | `aws/workflows/sql/123_checkalt_deposit_check_status.sql` (sha256 `8f742d9d853373ab0674d46d733ccdf2a9ede0c299f662b5e3b00991f240758f`) | When a Check Alt deposit is approved or accepted, its check moves to Deposited; when that deposit is later rejected, errors, is a duplicate or is returned, the check moves to Returned. Checks already approved and billed move once. |

**Why.** The owner, 2026-10-28: "When a check is deposited through Checcalt, it should
automatically move to deposited and not stay in ready for deposit", and "proceed with database
trigger that marks it deposited when check alt submits. If it is later rejected it shows up in
returned and not in deposited."

- Check Alt never moves the check itself. The submit, auto-approve and poll paths
  (`checkalt-idempotency.mjs` `persistProviderOutcome`, `persistAutoApproveOutcome`,
  `persistPollOutcome`) write `checkalt_deposits` only; no code sets `check_intake_items.status` /
  `check_stage` to `deposited` for a Check Alt deposit.
- The SPA shows the check under Deposited only while its deposit is `pending_approval`; once the
  deposit is `submitted` or `cleared` it falls back into Ready for deposit.

**What it changes.**

- `aws_checkalt_mark_check_deposited(uuid, timestamptz)` (new; SECURITY DEFINER,
  `search_path = public, pg_temp`, `row_security = off`, EXECUTE for the owner only): moves one check
  to Deposited the way the manual deposit path does (`status` and `check_stage` `deposited`,
  `deposited_at` kept or set to the deposit time). Only forward: from no stage, `review`,
  `loss_draft`, `endorsing` or `ready_for_deposit`, or from an open return Check Alt recorded (a
  resubmitted deposit), which it resolves (`return_resolution 'checkalt_redeposited'`). A check
  already deposited, funds released, disbursed externally, or returned by a bank or by hand is left
  as it is.
- `aws_apply_checkalt_check_status()` (new; SECURITY DEFINER, `search_path = public, pg_temp`,
  `row_security = off`, EXECUTE for the owner only) and its trigger
  `aws_checkalt_deposit_apply_check_status` (AFTER INSERT OR UPDATE OF status ON
  `checkalt_deposits`):
  - when a deposit becomes `submitted` or `cleared` from any other status: the helper above, with
    the deposit's `submitted_at`;
  - when it becomes `rejected`, `error`, `duplicate` or `returned` after it was `submitted` or
    `cleared`, and no other deposit of the check is `submitted` or `cleared`: the check moves to
    Returned with the columns the AWS `record_check_return` RPC writes (`check_stage` and `status`
    `returned`, `pre_return_stage`, `returned_at` = the deposit's, `return_code 'checkalt_<status>'`,
    `return_reason` = the deposit's, `return_source 'checkalt'`) and one `check_audit_log` row
    `check_returned`. The Returned tab lists it (`returned_at` set, return not resolved).
- The trigger's name sorts before `aws_checkalt_deposit_billing_event` (SQL 120) and
  `aws_checkalt_deposit_cash_job_payment` (SQL 121), so PostgreSQL fires it first. On approval the
  check is then already `deposited`: SQL 98's `record_check_billing_event` and
  `sync_cash_job_check_payment` record its one usage event and one cash-job payment, and SQL 120 and
  SQL 121 add nothing. On a rejection the check is already `returned`, so SQL 120 still voids the
  uninvoiced usage event and SQL 121 still removes the automatic cash-job payment.
- Once, for checks already stuck: every check with a `submitted` or `cleared` deposit that the
  helper would move and that already carries a `check_processing` usage event moves to Deposited
  with its deposit's `submitted_at`. A check without that event is left alone, so the file never
  creates a new charge. The inspect counts both groups
  (`checkalt_approved_checks_to_move`, `checkalt_approved_checks_left_unbilled`).
- The file refuses (`42704 sql123_check_stage_label_missing`) unless `public.check_stage` has the
  labels `deposited` and `returned`.

Not changed: SQL 98's, SQL 120's and SQL 121's functions and triggers; no column, policy, grant,
RLS setting or other table.

**One public trigger more.** Once applied, the DB validator's justified trigger set and
`EXPECTED_PUBLIC_TRIGGERS` (183 today, `aws/functions/api/db-readonly-validate.mjs`) must follow in
their own change, as #1309 did for SQL 120; not before the apply.

**Staging executor refreshed (2026-10-28).** Inspect run 40712994465 found the live executor at
`7wybTiIc…` without `sql/123_checkalt_deposit_check_status.sql`. Deploy run 40714754418 updated it to
main's package (`ucqjAOPXdW52npzxNv8RSV3rlmf6hvE5Pj1R77uQ4+c=`; "Verify live executor now carries
main's package" passed).

**Staging read-live (2026-10-28).** Run 40717225525 (main `6a7270f`):
`aws_checkalt_mark_check_deposited(uuid, timestamp with time zone)`,
`aws_apply_checkalt_check_status()` and the `aws_checkalt_deposit_apply_check_status` trigger on
`checkalt_deposits` absent; every prerequisite present; the definer writes to `check_intake_items`
and `check_audit_log` possible; `checkalt_approved_checks_to_move` 0,
`checkalt_approved_checks_left_unbilled` 1; live
`b584e1cd4352837eb5515cd07e76900e055637d11c29214db036f912e6b6f6b9`, `already_applied` false,
`precondition_failures` `[]`. Recorded in the staging pin (`expected_live_definition_sha256`,
`execute: true`, wave 22) under the owner's words of 2026-10-28, "Yes open both PRs".

**Staging apply (2026-10-28).** Run 40721665524 (main `19c9c71`, after #1334 merged the staging pin and
executor deploy run 40721058469 carried it, `W54SxDwd…`): receipt before
`b584e1cd4352837eb5515cd07e76900e055637d11c29214db036f912e6b6f6b9`, after
`e982bd786ca1b7bd107d4156359b32d5032fcb0b5e7962c5b2fd457387c230fc` (intended), result `applied`. Read-live
run 40722182617: `already_applied` true, `precondition_failures` `[]`.

**Production inspect (2026-10-28).** Read-only `--inspect` through SSM
`e8a92ced-8043-4d9f-ba81-2c19beebfcb9` on `i-0c35557c4e5385406`, main `1c6e3b4` (tarball sha256
`93cb0383aac2513e2a65c17d47351f0c0f3517f2e48f9903640f86bd7e929f3e`, transfer run 40722722727, migration
source `8f742d9d…` == pin), connected as `checksops_admin`: the two functions and the
`aws_checkalt_deposit_apply_check_status` trigger absent; every prerequisite present; the definer can write
`check_intake_items` and `check_audit_log`; `checkalt_approved_checks_to_move` 2 (staging had 0),
`checkalt_approved_checks_left_unbilled` 1; live
`b584e1cd4352837eb5515cd07e76900e055637d11c29214db036f912e6b6f6b9`, `already_applied` false,
`precondition_failures` `[]`, the same pre-state as staging's. Recorded in the production pin with the
staging apply as its staging acceptance and `execute: true` under the owner's words of 2026-10-28, "start
the SQL 123 pin PR". The owner merges the pin change; the apply still needs the owner's run-time approval
and runs only after that merge is on main and staged.

**Status:** applied to staging (wave 22); production pin execute-authorized; not applied to production.

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec
`sql123` in `release-sql-specs.mjs`): the two new functions' attributes, body hashes and EXECUTE
ACLs, and the trigger's definition. Intended
`e982bd786ca1b7bd107d4156359b32d5032fcb0b5e7962c5b2fd457387c230fc`:

```
release sql123 v1
function public.aws_checkalt_mark_check_deposited(uuid, timestamp with time zone): lang=plpgsql vol=v parallel=u secdef=true result=boolean config=row_security=off;search_path=public, pg_temp prosrc=4d8bdb8953956c6e1fdcaa8375310b4eed2fc30fa120c0e580c803ed0fad2da0 acl=owner EXECUTE
function public.aws_apply_checkalt_check_status(): lang=plpgsql vol=v parallel=u secdef=true result=trigger config=row_security=off;search_path=public, pg_temp prosrc=e454e4bd295a1db6c5f21f3c1b35cbed4c76c424321c8720be5ac365ce4121b8 acl=owner EXECUTE
trigger public.checkalt_deposits aws_checkalt_deposit_apply_check_status: enabled=O def=9130a05d15b360e507c3b071eec613601786e8568b6dbf97bc499eab8cc95f8f
```

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present` (`check_intake_items` with its deposit and return columns, the type
`check_stage`, `checkalt_deposits`, `check_audit_log`, `check_billing_events`);
`altered_relations_owned_by_login` (`checkalt_deposits`); `functions_owned_by_login`;
`function_acl_replaceable`; `definer_can_write_relations` (`check_intake_items`,
`check_audit_log`).

Post-conditions: the intended fingerprint; everything else in schema `public` (and the functions
of `auth`) unchanged. The tools roll back otherwise.

## Steps

1. Staging: the staging executor must carry SQL 123 first (executor package refresh through the
   guarded staging executor `deploy` mode, its own reviewed run). Then run the guarded staging SQL
   executor with `read-live` for `sql123-checkalt-deposit-check-status`. If it reports
   `prerequisites_missing` other than `[]` or `precondition_failures` other than `[]`, stop.
   Otherwise record `LIVE_DEFINITION_SHA256` in the staging pin (`expected_live_definition_sha256`,
   owner-approved `authorization`, `execute: true`) in a reviewed change, `apply`, then `read-live`
   again. Test on staging: deposit a check through Check Alt; it shows under Deposited once the
   deposit is approved; a rejected deposit shows under Returned.
2. Production: run the read-only inspect on the runner
   (`node scripts/deployment-guard/production-sql-one-shot.mjs --migration sql123 … --phase inspect`);
   record `production_inspect` (with the two counts) and copy `live_definition_sha256` into
   `expected_live_definition_sha256`; record the staging runs in `staging_acceptance`; set an
   owner-approved `authorization` and `execute: true`, in one reviewed change.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs
   --migration sql123 --approval-scope sql123 … --phase apply` with the owner's words.
4. Record the apply and retire the pin (`execute: false`). Then, in its own change, the DB
   validator's justified trigger set and expected count (one public trigger more).
