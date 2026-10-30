# Production SQL 130 (financial TOTP rate limit accepts `code_check`; no `PUBLIC` EXECUTE)

| key | file | what it does |
|---|---|---|
| `sql130` | `aws/workflows/sql/130_financial_totp_rate_limit_code_check_no_public.sql` (sha256 `da17dd5d4a74bcf9c5b59dc13bf3a557e3488c5f36ab0b8431a2b8b67fefc561`) | `CREATE OR REPLACE` of `consume_financial_totp_rate_limit(uuid, text, integer, integer)` with the same signature, `TABLE` result, `plpgsql`, `VOLATILE`, `SECURITY DEFINER` and `search_path = public, pg_temp`, and SQL 129's body: the live one except the action allow-list, which also accepts `code_check`. Then `REVOKE EXECUTE ... FROM PUBLIC` and `GRANT EXECUTE ... TO checksops` on that one function. No other statement. |

**Why.** Since the finding 7 deploy (production overlay run 40992441506, 2026-10-30) the API
rate-limits every authenticator-code check under one action, `code_check`
(`aws/functions/api/auth-financial-totp.mjs`: enroll confirm and step-up;
`providers/production/checkalt-register.mjs`: the finding 13 deposit-account change). The read-only
financial TOTP live inspect of 2026-10-30 (SSM `cfee4512-4988-4fd1-be77-b03d1b4cd50b`, main
`da064a34`, `ops/security/FINANCIAL_TOTP_LIVE_INSPECT.md`) found the live function equal to
`aws/migrations/proposed/NOT_APPLIED_20260911_financial_totp_enrollment.sql`: it allows only
`enroll_start`, `enroll_confirm` and `step_up` and raises `invalid_rate_limit_action` otherwise. Every
code check therefore fails and the API answers 401 `financial_totp_failed`: enrolling an
authenticator, every financial step-up and the Check Alt deposit-account change.

**Why SQL 130 and not SQL 129.** SQL 129 (`ops/production-sql-129-apply.md`) changes only the body
and keeps the ACL, and its intended fingerprint names `PUBLIC` as production has it. The guarded
staging SQL executor read-live of SQL 129 (run 41081764481 on main `f2bb55b1`, executor CodeSha256
`+2f0KhpfRn1/njlZrwya5TAQDyyddkse3VuK6gr3gBc=`) reported `already_applied` false,
`precondition_failures` `[]`, `live_definition_sha256`
`1b805d53c7a00f90bf4341045b21f25893b3ddf2f56dd51b9a48ee2045a04bb7` and `function_acl`
`checksops EXECUTE`, `owner EXECUTE`: the same body as production without `PUBLIC`. That hash is
`releaseStateHash('sql129', …)` of the proposed file's state with `PUBLIC EXECUTE` removed, so on
staging SQL 129 would miss its fingerprint and roll back. Owner decision 2026-10-30, "New combined
fix": one new migration that adds `code_check` and revokes `PUBLIC` EXECUTE on this one function, so
both databases converge to the same state. SQL 129 is retired without being applied (its staging
pin carries a retirement `authorization`; its production pin stays pending with `execute: false`).

**What it changes.** One line of the body (the allow-list is `enroll_start`, `enroll_confirm`,
`step_up`, `code_check`) and the EXECUTE ACL: `PUBLIC` is removed where it is granted (production)
and nothing changes where it is not (staging). `checksops` (the API login) and the owner keep
EXECUTE; the `GRANT ... TO checksops` repeats a grant both databases already hold, as the
function's own proposed file pairs its `REVOKE` and `GRANT`. The caller check
(`p_user_id = auth.uid()`), the limit and window bounds and the per-user, per-action counter in
`financial_totp_rate_limits` are unchanged.

Not changed: the other `financial_totp_*` functions (their ACLs are a separate migration), any table,
column, policy, RLS setting, table grant, trigger or row; the lockout behavior. No API, Lambda or SPA
change is part of this file or its pins. No trigger is added.

**Staging executor refreshed (2026-10-30).** Inspect run 41086925906 found the live executor at
`+2f0KhpfR…` without `sql/130_financial_totp_rate_limit_code_check_no_public.sql`. Deploy run
41087238803 updated it to main's package (`WhquviZ/jvETdQAPUPliD7meJbBupiILVJDCurPF12E=`, RevisionId
`0716c90d-b85f-494e-b3be-fbfe6ef431a3`; `errors` `[]`).

**Staging read-live (2026-10-30).** Run 41087643551 (main `81b188b97`):
`consume_financial_totp_rate_limit(uuid, text, integer, integer)` present with the proposed file's
body (state `different`), EXECUTE for `checksops` and the owner only; every prerequisite present
(`prerequisites_missing` `[]`); live `cb2fd65bb580f9338cab728c2507a32b7589aee5e702d117c31e1862f98a5a19` (the staging pre-state derived above),
`already_applied` false, `precondition_failures` `[]`. Recorded in the staging pin
(`expected_live_definition_sha256`, `execute: true`, wave 28) under the owner's words of 2026-10-30,
"continue with SQL 130 staging".

**Staging apply (2026-10-30).** Run 41090274902 (main `66a0baaf2`, staging pin PR #1451, on the executor
deployed by run 41089857134, `5OmSJSao…`; workstream `github-staging-sql-41090274902`) under the owner's
words "apply SQL 130 in staging": receipt before
`cb2fd65bb580f9338cab728c2507a32b7589aee5e702d117c31e1862f98a5a19`, after
`013549faba6166280b03df404ca23c1973870efad9f7d499d6a695be0de7246b` (intended), result `applied`. Read-live
run 41090642842: `already_applied` true, live `013549fa…`, `function_acl` `checksops EXECUTE` and
`owner EXECUTE`.

**Production inspect (2026-10-30).** Read-only `--inspect` through SSM
`88570df0-02e3-408f-8f1d-1fdddd0dadda` on `i-0c35557c4e5385406`, main `66a0baaf2` (tarball sha256
`8cb7d3398830c6b5c69b185b6d1bf6da2a6dde05633abdea21678753450a2089`, transfer run 41091045905, migration
source `da17dd5d…` == pin), connected as `checksops_admin`:
`consume_financial_totp_rate_limit(uuid, text, integer, integer)` `different` (`function_acl`
`PUBLIC EXECUTE`, `checksops EXECUTE` and `owner EXECUTE`); every prerequisite present; live
`e49dc44662d1ac04762cf06d139f527d9a09158cbccd64fc8370d62e1f43c838`, `already_applied` false,
`precondition_failures` `[]`. That is the production pre-state derived above from the proposed file's
bytes; it differs from staging's (`cb2fd65b…`) only by the `PUBLIC` EXECUTE grant, which the file
revokes, so both reach the same intended state (`aws/tests/sql130-financial-totp-rate-limit-pg.test.mjs`
applies from both). Recorded in the production pin with the staging apply as its staging acceptance and
`execute: true` under the owner's words of 2026-10-30, "apply SQL 130 in production" (given before the
pin existed). The owner merges the pin change; the apply still needs the owner's run-time approval and
runs only after that merge is on main and staged.

**Status:** applied to staging (wave 28); production pin execute-authorized; not applied to production.

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec
`sql130` in `release-sql-specs.mjs`). Intended
`013549faba6166280b03df404ca23c1973870efad9f7d499d6a695be0de7246b`:

```
release sql130 v1
function public.consume_financial_totp_rate_limit(uuid, text, integer, integer): lang=plpgsql vol=v parallel=u secdef=true result=TABLE(allowed boolean, count integer, retry_after_seconds integer) config=search_path=public, pg_temp prosrc=dbc080aabbcfe53da091c08f51bba1c88ad70593cddac4f7daa3ae224d32412e acl=checksops EXECUTE;owner EXECUTE
```

**Expected pre-states.** Both are the proposed file's function (body sha256
`0507b4474de7fb03ac843f44c2ad7bd06f603620905ab58b550d3b4e379b4d24`, equal to the `prosrc_sha256` the
production live inspect read); they differ only in `PUBLIC`. Each is derived from the proposed file's
bytes by `aws/tests/release-sql130-executor.test.mjs` and read back from a PostgreSQL 16 database with
that function loaded:

| environment | EXECUTE | fingerprint under `sql130` | recorded in |
|---|---|---|---|
| production | `PUBLIC`, `checksops`, owner | `e49dc44662d1ac04762cf06d139f527d9a09158cbccd64fc8370d62e1f43c838` | the production pin, from the one-shot `--phase inspect` |
| staging | `checksops`, owner | `cb2fd65bb580f9338cab728c2507a32b7589aee5e702d117c31e1862f98a5a19` (SQL 129's `1b805d53…` state under the `sql130` key) | the staging pin, from the staging read-live |

Each pin records its own environment's read; neither value is written into a pin before a run reads
it. A pre-state other than these is not by itself a stop, but its per-function report and ACL must be
read and explained before it is recorded.

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present` (`consume_financial_totp_rate_limit(uuid, text, integer, integer)`,
`financial_totp_rate_limits` with `user_id`, `action`, `window_started_at` and `request_count`, role
`checksops`); `functions_owned_by_login`; `function_results_match` (the `TABLE` result);
`function_acl_replaceable` (no EXECUTE grant outside `checksops` and the owner, which the file keeps,
and `PUBLIC`, which it revokes).

Post-conditions: the intended fingerprint; the function owned by the login; everything else in schema
`public` (and the functions of `auth`) unchanged. The tools roll back otherwise.

## Steps

1. Staging: the staging executor must carry SQL 130 first (executor package refresh through the
   guarded staging executor `deploy` mode, its own reviewed run). Then run the guarded staging SQL
   executor with `read-live` for `sql130-financial-totp-rate-limit-code-check-no-public`. Expected:
   `already_applied` false, `precondition_failures` `[]`, `live_definition_sha256`
   `cb2fd65b…` (above). If it reports `prerequisites_missing` other than `[]` or
   `precondition_failures` other than `[]`, stop. Otherwise record `LIVE_DEFINITION_SHA256` in the
   staging pin (`expected_live_definition_sha256`, owner-approved `authorization`, `execute: true`) in
   a reviewed change, `apply`, then `read-live` again.
2. Production: run the read-only inspect on the runner
   (`node scripts/deployment-guard/production-sql-one-shot.mjs --migration sql130 … --phase inspect`);
   record `production_inspect` and copy `live_definition_sha256` into
   `expected_live_definition_sha256`; record the staging runs in `staging_acceptance`; set an
   owner-approved `authorization` and `execute: true`, in one reviewed change.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs
   --migration sql130 --approval-scope sql130 … --phase apply` with the owner's words
   (authorization phrase `APPLY_FINANCIAL_TOTP_RATE_LIMIT_CODE_CHECK_NO_PUBLIC`).
4. Record the apply and retire the pin (`execute: false`).
