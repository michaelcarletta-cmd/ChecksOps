# Production SQL 174 (Check Alt: the one deposit attempt stranded before the provider sign-in goes back to queued)

| key | file | what it does |
|---|---|---|
| `sql174` | `aws/workflows/sql/174_checkalt_reset_stranded_attempt.sql` (sha256 `7e69502ed9b7ced71feb95b7e7ed457518c33cfb43d9a7f40dde8f2c17edfc4b`, authored by `1118ba3cd`) | Refuses without its prerequisites (`55000 sql174_prerequisite_missing`) or unless the applying login can read and write `checkalt_deposits` and `check_intake_items` past row security (`55000 sql174_definer_cannot_read`); then creates the owner-only SECURITY DEFINER `aws_checkalt_reset_stranded_attempt` and calls it once for the minute 2026-11-24 19:58 UTC: exactly one stranded attempt goes back to `queued`, none is a no-op, more than one raises `55000 sql174_ambiguous_stranded_attempts` and nothing changes. |

**Why.** Owner 2026-11-24: "start step 3" (clear the one stranded CheckAlt deposit attempt). Before PR 2068,
`checkalt-submit.mjs` ran `markHttpAttempted` (`aws/functions/api/providers/production/checkalt-idempotency.mjs`)
before the Check Alt sign-in. On 2026-11-24 the sign-in answered 504 ("CheckAlt auth failed [504]", CloudWatch
19:58:54 UTC), so no `POST /fincapture/deposit/process` was sent; the owner confirmed in the Check Alt portal that no
deposit went through. The attempt row stayed `status 'submitting'`, `provider_http_attempted_at` set, payload
`{"phase": "submitting", "provider_http_attempted": true}`, no `checkalt_reference`. `rowHasProviderHttpAttempt` is true
for it (the column, the payload flag), so every later press answers `reconciliation_required` and the check cannot be
deposited. PR 2068 (live in production since run 45487777493) now signs in first, so no new row strands this way.

The read-only production inspect of PR 2067 (`checkalt-deposit-state-inspect`, SSM
`9eb0173e-0540-467f-b108-8fb6edc727e2`, source commit `07068a8a`) found exactly one such row of 92: status
`submitting`, `checkalt_reference` NULL, `provider_http_attempted_at` set, created / attempted / updated in the minute
2026-11-24 19:58 UTC, `failure_class` NULL, `last_error` NULL, phase `submitting`; its check not deposited
(`deposited_at` NULL, `approved_for_deposit`, `ready_for_deposit`) and with no other `checkalt_deposits` row.

**What it does.**
- A new function `public.aws_checkalt_reset_stranded_attempt(p_window_start timestamptz, p_window_end timestamptz)`
  returns integer (plpgsql, VOLATILE, SECURITY DEFINER, `search_path = public, pg_temp`, `row_security = off`, owned by
  the applying login; EXECUTE revoked from PUBLIC, `anon`, `authenticated`, `service_role` and `checksops`: only the
  owner, the guarded admin path, can run it). It names no deposit, check, tenant, user or amount. In a window of at most
  one hour (else `22023 sql174_invalid_window`) it locks and counts the rows with ALL of: `checkalt_reference` NULL;
  `status = 'submitting'`; `provider_http_attempted_at` and `created_at` in `[start, end)`; `failure_class` NULL;
  `last_error` NULL; `last_status_payload->>'phase' = 'submitting'`; the check (`check_intake_items`) with
  `deposited_at` NULL; no other `checkalt_deposits` row for that check.
  - more than one: `55000 sql174_ambiguous_stranded_attempts`, the transaction rolls back, nothing changes;
  - none: returns 0, nothing changes (NOTICE `sql174_already_reset` when a row of the window is already reset, else
    `sql174_no_stranded_attempt`);
  - exactly one: the row goes back to the state `insertQueuedDeposit` leaves: `status 'queued'`,
    `provider_http_attempted_at` NULL, `last_status_payload` merged with `{"phase": "queued_before_http",
    "provider_http_attempted": false, "stranded_reset": {"reason": "pre_provider_sign_in_504", "migration": "174",
    "at": now()}}` (the other payload keys, `scale` and `amount_cents`, kept), `updated_at` now(); returns 1.
    `checkalt_reference` stays NULL; `amount`, `amount_cents`, `idempotency_key`, `tenant_id`, `check_intake_item_id`,
    `submitted_by` and every other column are untouched. The UPDATE re-checks the whole rule; anything but one row
    raises `sql174_ambiguous_stranded_attempts`.
- The file calls it once for `[2026-11-24 19:58:00+00, 2026-11-24 19:59:00+00)`.
- After the reset the API sees the row as a fresh attempt: `rowHasProviderHttpAttempt`, `shouldReconcileInsteadOfPost`
  and `shouldBlockNewProcessPost` are false, and `markHttpAttempted`'s WHERE (`provider_http_attempted_at IS NULL`,
  `checkalt_reference IS NULL`, status `queued`) claims it on the next Deposit press. The press must carry the same amount
  (the idempotency key includes `amount_cents`); a different amount inserts a new row and leaves this one queued.
  `aws/tests/release-sql174-executor.test.mjs` checks this against the API's own functions.
- Triggers: the four AFTER INSERT OR UPDATE OF status triggers on `checkalt_deposits` (SQL 120's billing event, SQL
  121's cash-job payment, SQL 123's check status, SQL 152's failed-deposit fee) act only when a deposit becomes
  `submitted` / `cleared` or `rejected` / `error` / `duplicate` / `returned`; for `submitting` -> `queued` each returns
  without a write (proven with the real files on PostgreSQL 16).
- Idempotent: `CREATE OR REPLACE FUNCTION`, the REVOKEs; a second call finds no stranded row and returns 0. The tools
  refuse a second apply anyway (the function is in place: `already_applied`).

**Not changed:** no table, column, constraint, index, trigger, policy or grant; `check_intake_items` is only read; no
other `checkalt_deposits` row. No API, Lambda or SPA change.

**Status:** tooling built; staging and production pins pending (`execute: false`). Nothing applied or read. Staging
wave 66 when approved (wave 65 is SQL 173's, also pending; wave 64, SQL 172, is the highest applied).

## Order

No predecessor in the release engine. The file reads the columns of `checkalt_deposits` that financial SQL 65 added
(`provider_http_attempted_at`, `failure_class`, `last_error`) and refuses with `sql174_prerequisite_missing` without
them.

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec `sql174` in
`release-sql-specs.mjs`). The fingerprint is the function's; the row the file resets is data. Intended
`ad7969b5de482398d396216a1232de1d5f1faad8a8e3df01b7631538a0f1b46c`:

```
release sql174 v1
function public.aws_checkalt_reset_stranded_attempt(timestamp with time zone, timestamp with time zone): lang=plpgsql vol=v parallel=u secdef=true result=integer config=row_security=off;search_path=public, pg_temp prosrc=ecb42cf37f66ca0ee50e45afd434d8cedfd2d0c4d41c78386df31e57486fe99b acl=owner EXECUTE
```

**Expected pre-state (both environments).** The function absent:

```
release sql174 v1
function public.aws_checkalt_reset_stranded_attempt(timestamp with time zone, timestamp with time zone): absent
```

That is `51db2d269aed8dc824b02831671c6e945fde3cd2d772e167e6ea6bfe6824e83f` (`releaseStateHash('sql174', {})`). Each pin
records its own environment's read; neither value is written into a pin before a run reads it. A pre-state other than
this one is a stop.

## The data rule (differs by environment)

The inspect reports two declared aggregate counts (never ids, amounts or names), with the function's own rule for the
minute 2026-11-24 19:58 UTC:

- `checkalt_stranded_attempts_in_window`: the attempts the function would reset;
- `checkalt_reset_attempts_in_window`: rows of that minute already reset (`queued`, not attempted, `stranded_reset` in
  the payload), informational.

The precondition `checkalt_stranded_attempt_in_window` (release engine, as SQL 98's fee-destination rule differs by
environment) requires `checkalt_stranded_attempts_in_window` **exactly 1 on production** and **0 on staging**; any other
value, or an unreadable count, refuses before the file runs.

- **Staging**: the row exists only in production, so staging holds none; the staging apply proves the file's
  prerequisites, the owner-only function (body, ACL, fingerprint), a run as the executor login, the zero-row path
  (returns 0, nothing written) and that nothing else in the catalog changed. The owner accepted that staging acceptance
  on 2026-11-24. The one-row reset, every near miss, the abort on two matches, the re-run and the triggers are proven on
  PostgreSQL 16 (`aws/tests/sql174-checkalt-reset-stranded-attempt-pg.test.mjs`).
- **Production**: the inspect must report `checkalt_stranded_attempts_in_window` 1 and
  `checkalt_reset_attempts_in_window` 0. After the apply: 0 and 1.

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present` (`checkalt_deposits`, `check_intake_items` and the columns the function reads and writes);
`definer_can_write_relations` on `checkalt_deposits` and `check_intake_items` (the function updates and reads them past
row security); `checkalt_stranded_attempt_in_window` (above); `functions_owned_by_login`, `function_results_match` and
`function_acl_replaceable` (the function absent, or owned by the login with the same result type and only the ACL
entries the file sets).

Post-conditions: the intended fingerprint; the function owned by the login; everything else in schema `public`
unchanged. The tools roll back otherwise.

## Steps

Each step is its own reviewed PR or run and waits for the owner's words for that step.

1. Staging: the staging executor must carry SQL 174 first (executor package refresh through the guarded staging executor
   `deploy` mode, its own reviewed run; the package carries the file, the spec and the engine's new precondition). Then
   `read-live` for `sql174-checkalt-reset-stranded-attempt`. Expected `already_applied` false, `precondition_failures`
   `[]`, `prerequisites_missing` `[]`, `predecessors` `{}`, counts `checkalt_stranded_attempts_in_window` 0, live
   `51db2d26…`. Otherwise stop. Record `LIVE_DEFINITION_SHA256` in the staging pin (`expected_live_definition_sha256`,
   owner-approved `authorization`, `execute: true`, wave 66) in a reviewed change, `apply`, then `read-live` again.
2. Production: with the owner's OK for that read, the read-only inspect on the runner
   (`node scripts/deployment-guard/production-sql-one-shot.mjs --migration sql174 … --phase inspect`). Expected counts
   `checkalt_stranded_attempts_in_window` 1, `checkalt_reset_attempts_in_window` 0, `precondition_failures` `[]`, live
   `51db2d26…`; otherwise stop. Record `production_inspect`, copy `live_definition_sha256` into
   `expected_live_definition_sha256`, record the staging runs in `staging_acceptance`, set an owner-approved
   `authorization` and `execute: true`, in one reviewed change.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs --migration sql174
   --approval-scope sql174 … --phase apply` with the owner's words (authorization phrase
   `RESET_STRANDED_CHECKALT_ATTEMPT`). The post-apply inspect must report counts 0 and 1.
4. Record the apply and retire the pin (`execute: false`).
5. The owner presses Deposit once for that check (same amount) and confirms in the Check Alt portal that exactly one
   deposit arrived.

Rollback (not part of this pin; a reviewed step of its own if ever needed): drop the function. The reset row is not put
back to `submitting` (that state only blocks the check); a deposit sent since is the provider's record.
