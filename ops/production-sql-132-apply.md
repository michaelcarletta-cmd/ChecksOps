# Production SQL 132 (financial TOTP lockout after repeated code checks)

| key | file | what it does |
|---|---|---|
| `sql132` | `aws/workflows/sql/132_financial_totp_code_check_lockout.sql` (sha256 `ca91ce9c04e09715fa01f54fe9dc81a88cb22a3e0ea1e3994b9ffc63b55566eb`) | Refuses without the financial TOTP enrollment schema (`55000 sql132_prerequisite_missing`) or when the applying login could not write `financial_totp_enrollments` as a DEFINER owner (`55000 sql132_definer_cannot_write`). Then `CREATE OR REPLACE` of the new `financial_totp_count_code_check(uuid)` (`plpgsql`, `VOLATILE`, `SECURITY DEFINER`, `search_path = public, pg_temp`, `RETURNS TABLE(allowed boolean, failed_attempts integer, retry_after_seconds integer)`), `REVOKE ALL ... FROM PUBLIC` and `GRANT EXECUTE ... TO checksops` on it. No other statement. |

**Why.** `public.financial_totp_enrollments` has `failed_attempts` and `locked_until`
(`aws/migrations/proposed/NOT_APPLIED_20260911_financial_totp_enrollment.sql`, the live definition per
the read-only financial TOTP inspect of production on 2026-10-30, SSM
`cfee4512-4988-4fd1-be77-b03d1b4cd50b`, `ops/security/FINANCIAL_TOTP_LIVE_INSPECT.md`), but nothing
ever increments `failed_attempts` or sets `locked_until`: `financial_totp_get_enrollment(uuid)` only
returns them and `financial_totp_mark_verified(uuid, bigint)` only resets them on a success. The API
connects as `checksops`, which holds no privilege on the table, so it cannot keep the counter itself.
The only bound on guessing a 6-digit authenticator code is SQL 130's rate limit (`code_check`, 5 per
300 s per user): about 1440 guesses a day, for ever. Owner 2026-10-30: "restart SQL 131 and the
lockout fix".

**What it changes.** One new function, `financial_totp_count_code_check(p_user_id uuid)`. The API
calls it once per code check (enroll confirm, financial step-up and the Check Alt deposit-account
change), after it has read the enrollment and before it compares the code, and commits the count
before the comparison (a wrong code fails the request and rolls it back). The function:

- requires `p_user_id = auth.uid()` (`42501 enrollment_caller_mismatch`; `22023 invalid_enrollment` for
  NULL): a caller can neither count against nor read another user's row;
- while `locked_until > now()` changes nothing and returns `allowed false` with the seconds left; the
  API then refuses without comparing the code, with the same answer as a wrong code (no oracle);
- otherwise, in one `UPDATE` of the user's row, `failed_attempts + 1`, and `locked_until = now() + 15
  minutes` when that reaches 10; returns `allowed true` and the new count. The row lock serializes
  concurrent checks and the `UPDATE` re-reads the row after waiting for it, so no check slips past a
  lock another check has just set. A correct code is cleared by `financial_totp_mark_verified`
  (unchanged: `failed_attempts 0`, `locked_until NULL`), so `failed_attempts` counts the consecutive
  checks without a success. An expired lock does not reset the count: after the first lockout each
  further check without a success locks the row again, until a correct code;
- returns no row for a user without an enrollment (the API answers not enrolled).

Why 10 and 15 minutes: the rate limit already stops the sixth check inside 300 s, so a person with an
authenticator never reaches ten consecutive failures by mistyping; ten failures need at least two
rate-limit windows of nothing but wrong codes. 15 minutes is three rate-limit windows: guessing drops
from 1440 codes a day to about 96 (one per 15 minutes once locked), while a real user who mistypes
after a lockout waits 15 minutes, not longer.

EXECUTE: revoked from `PUBLIC` (a new function is otherwise executable by every login), granted to
`checksops` (the API login); the owner keeps its own. The ACL is `checksops` and the owner, as the
proposed file's functions and SQL 130 pair theirs.

Not changed: no table, column, policy, RLS setting, table grant, trigger or row; no other function
(`financial_totp_get_enrollment`, `financial_totp_mark_verified`, `financial_totp_upsert_enrollment`,
`financial_totp_status`, SQL 130's `consume_financial_totp_rate_limit`) and none of their ACLs (the
`PUBLIC` EXECUTE on the four proposed-file functions is SQL 131's). No reset path: nothing here clears
a lock; a correct code does, as before. The replay window of an older used step is not changed. No
API, Lambda or SPA change is part of this file or its pins: the API change that calls the function
(`aws/functions/api/auth-financial-totp.mjs`, `providers/production/checkalt-register.mjs`) tolerates
its absence (no count, no lockout, never a 500) and is deployed through the guarded Lambda path after
SQL 132 is applied in that environment. No trigger is added.

**Predecessor.** SQL 130 (`ops/production-sql-130-apply.md`, applied to staging and production on
2026-10-30): the engine refuses SQL 132 (`predecessors_applied`) until
`consume_financial_totp_rate_limit(uuid, text, integer, integer)` is at SQL 130's intended state.

**Staging executor refreshed (2026-10-30).** Inspect run 41112932726 (main `55cd626f`) found the live
executor at `jOd0IqUJ…` without `sql/132_financial_totp_code_check_lockout.sql` (main's package also
superseded `lib/release-sql-specs.mjs`, `lib/release-sql-state.mjs` and `lib/sql-executor-auth.mjs`;
`collisions` `[]`). Deploy run 41113385981 (main `546dd7cb839153b161f0e8f5f6a3927c6ee29084`) updated it
to main's package (`J75AEogmHX9pvZxfn458CPfzQxhryyeJYz/r1Tk8dl0=`, RevisionId
`9e68fd37-f226-4c18-8f52-4f1e20f9b58e`; `errors` `[]`; verified current).

**Staging read-live (2026-10-30).** Run 41113777003 (main `546dd7cb839153b161f0e8f5f6a3927c6ee29084`,
executor `J75AEogm…`): `financial_totp_count_code_check(uuid)` absent (`function_acl` `[]`); every
prerequisite present (`prerequisites_missing` `[]`); `predecessors.sql130` true; the definer write on
`financial_totp_enrollments` ok; live `e1a1d4edb115e3fa0881112e6759c2d7ee1e9d8c6b3e24a7611b655dcf75741f` (the
pre-state derived above, the function absent), `already_applied` false, `precondition_failures` `[]`.
Recorded in the staging pin (`expected_live_definition_sha256`, `execute: true`, wave 29) under the
owner's words of 2026-10-30, "continue with SQL 132 staging".

**Staging apply (2026-10-30).** Run 41117004966 (main `42068df3f516653ebb96cffbf4d522f0117db4ac`, staging
pin PR #1461, on the executor deployed by run 41116686272, `aBuDhgGl…`, RevisionId
`9c082867-4ad1-4e22-be11-09c5c1a50a7b`; workstream `github-staging-sql-41117004966`) under the owner's
words "apply SQL 132 in staging": receipt before
`e1a1d4edb115e3fa0881112e6759c2d7ee1e9d8c6b3e24a7611b655dcf75741f`, after
`88828cb48d8b847cf177d57314bdbc0c8a1f49051958be5adb264a0c418ebd72` (intended), result `applied`;
`financial_totp_count_code_check(uuid)` `intended`, `function_acl` `checksops EXECUTE` and
`owner EXECUTE`, `definer_writes` ok. Read-live run 41117375887: `already_applied` true, live
`88828cb4…`.

**Production inspect (2026-10-30).** Read-only `--inspect` through SSM
`ea2ce576-471a-4a90-bb50-e52b3430e6ec` on `i-0c35557c4e5385406`, main `42068df3f` (tarball sha256
`4000d070b6f33d354b8a102fc08319ddcc624e8acf73ab07f9ce1c54247b6e33`, transfer run 41117411043, migration
source `ca91ce9c…` == pin), connected as `checksops_admin`: `financial_totp_count_code_check(uuid)`
`absent` (`function_acl` `[]`); every prerequisite present; `predecessors.sql130` true; the definer
write on `financial_totp_enrollments` ok; live
`e1a1d4edb115e3fa0881112e6759c2d7ee1e9d8c6b3e24a7611b655dcf75741f`, `already_applied` false,
`precondition_failures` `[]`. That is the pre-state derived above (the function absent), the same one
staging had, so the staging apply took the path production will
(`aws/tests/sql132-financial-totp-lockout-pg.test.mjs`). Recorded in the production pin with the
staging apply as its staging acceptance and `execute: true`; the owner's words so far ("restart SQL
131 and the lockout fix", "Merge SQL 131 and the lockout fix when green", "continue with SQL 132
staging", "merge 1461 when green", "apply SQL 132 in staging") name the restart, the merges and the
staging step, not the production apply. The owner merges the pin change; the apply still needs the
owner's words for that run and runs only after that merge is on main and staged.

**Status:** applied to staging (wave 29); production pin execute-authorized; not applied to production.

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec
`sql132` in `release-sql-specs.mjs`). Intended
`88828cb48d8b847cf177d57314bdbc0c8a1f49051958be5adb264a0c418ebd72`:

```
release sql132 v1
function public.financial_totp_count_code_check(uuid): lang=plpgsql vol=v parallel=u secdef=true result=TABLE(allowed boolean, failed_attempts integer, retry_after_seconds integer) config=search_path=public, pg_temp prosrc=ed07934529788cf62763149696f153d55b0f40bc5281dfada6779532f847c2ee acl=checksops EXECUTE;owner EXECUTE
```

**Expected pre-state (both environments).** The function absent, everything else in place:

```
release sql132 v1
function public.financial_totp_count_code_check(uuid): absent
```

That is `e1a1d4edb115e3fa0881112e6759c2d7ee1e9d8c6b3e24a7611b655dcf75741f`, derived by
`aws/tests/release-sql132-executor.test.mjs` and read back from a PostgreSQL 16 database with the
proposed file and SQL 130 loaded. Each pin records its own environment's read; neither value is
written into a pin before a run reads it. A pre-state other than this one is not by itself a stop,
but its per-function report and ACL must be read and explained before it is recorded.

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present` (`financial_totp_enrollments` with `application_user_id`, `failed_attempts`
and `locked_until`, `financial_totp_mark_verified(uuid, bigint)`, `auth.uid()`, role `checksops`);
`predecessors_applied` (SQL 130); `definer_can_write_relations` (the applying login owns
`financial_totp_enrollments` without `FORCE ROW LEVEL SECURITY`, or is a superuser or `BYPASSRLS`);
and, where the function already exists (a re-run), `functions_owned_by_login`,
`function_results_match` (the `TABLE` result) and `function_acl_replaceable` (no EXECUTE grant outside
`checksops` and the owner, which the file keeps, and `PUBLIC`, which it revokes).

Post-conditions: the intended fingerprint; the function owned by the login; everything else in schema
`public` (and the functions of `auth`) unchanged. The tools roll back otherwise.

## Steps

1. Staging: the staging executor must carry SQL 132 first (executor package refresh through the
   guarded staging executor `deploy` mode, its own reviewed run). Then run the guarded staging SQL
   executor with `read-live` for `sql132-financial-totp-code-check-lockout`. Expected:
   `already_applied` false, `predecessors` `{ sql130: true }`, `precondition_failures` `[]`,
   `live_definition_sha256` `e1a1d4ed…` (above). If it reports `prerequisites_missing` other than
   `[]` or `precondition_failures` other than `[]`, stop. Otherwise record `LIVE_DEFINITION_SHA256`
   in the staging pin (`expected_live_definition_sha256`, owner-approved `authorization`,
   `execute: true`) in a reviewed change, `apply`, then `read-live` again.
2. Production: run the read-only inspect on the runner
   (`node scripts/deployment-guard/production-sql-one-shot.mjs --migration sql132 … --phase inspect`);
   record `production_inspect` and copy `live_definition_sha256` into
   `expected_live_definition_sha256`; record the staging runs in `staging_acceptance`; set an
   owner-approved `authorization` and `execute: true`, in one reviewed change.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs
   --migration sql132 --approval-scope sql132 … --phase apply` with the owner's words
   (authorization phrase `APPLY_FINANCIAL_TOTP_LOCKOUT`).
4. Record the apply and retire the pin (`execute: false`).
5. Only then deploy the API change through the guarded Lambda path
   (`ops/lambda-configuration-change.md`, `ops/production-lambda-rebuild.md`); until then the API
   finds no `financial_totp_count_code_check` and behaves as before SQL 132 (no lockout, the rate
   limit only).
