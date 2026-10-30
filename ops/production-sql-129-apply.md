# Production SQL 129 (financial TOTP rate limit accepts `code_check`)

| key | file | what it does |
|---|---|---|
| `sql129` | `aws/workflows/sql/129_financial_totp_rate_limit_code_check.sql` (sha256 `7c4c5f8be1baf6acbdabd27884952c34fac729aea50c95d3bfb5fb8ba693905a`) | `CREATE OR REPLACE` of `consume_financial_totp_rate_limit(uuid, text, integer, integer)` with the same signature, `TABLE` result, `plpgsql`, `VOLATILE`, `SECURITY DEFINER` and `search_path = public, pg_temp`. The body is the live one except the action allow-list, which also accepts `code_check`. No `GRANT`, `REVOKE` or other statement. |

**Why.** Since the finding 7 deploy (production overlay run 40992441506, 2026-10-30) the API
rate-limits every authenticator-code check under one action, `code_check`
(`aws/functions/api/auth-financial-totp.mjs`: enroll confirm and step-up;
`providers/production/checkalt-register.mjs`: the finding 13 deposit-account change). The read-only
financial TOTP live inspect of 2026-10-30 (SSM `cfee4512-4988-4fd1-be77-b03d1b4cd50b`, main
`da064a34`, `ops/security/FINANCIAL_TOTP_LIVE_INSPECT.md`) found the live function equal to
`aws/migrations/proposed/NOT_APPLIED_20260911_financial_totp_enrollment.sql`: it allows only
`enroll_start`, `enroll_confirm` and `step_up` and raises `invalid_rate_limit_action` otherwise. Every
code check therefore fails and the API answers 401 `financial_totp_failed`: enrolling an
authenticator, every financial step-up (approving deposits, sending disbursements) and the Check Alt
deposit-account change. Owner, 2026-10-30: "build SQL 129".

**What it changes.** One line of the body: the allow-list is `enroll_start`, `enroll_confirm`,
`step_up`, `code_check`. The three older actions stay accepted so an API build still on them keeps
working. The caller check (`p_user_id = auth.uid()`), the limit and window bounds and the per-user,
per-action counter in `financial_totp_rate_limits` are unchanged.

Not changed: the EXECUTE ACL (production: `PUBLIC`, `checksops` and the owner; `CREATE OR REPLACE`
keeps it), the other `financial_totp_*` functions, any table, column, policy, RLS setting, grant,
trigger or row. Revoking `PUBLIC` EXECUTE from the `financial_totp_*` functions is a separate finding
and a separate migration. No API, Lambda or SPA change is part of this file or its pins. No trigger is
added.

**Staging read-live (2026-10-30).** The guarded staging SQL executor read-live of SQL 129 (run
41081764481 on main `f2bb55b1`, executor CodeSha256 `+2f0KhpfRn1/njlZrwya5TAQDyyddkse3VuK6gr3gBc=`)
reported `already_applied` false, `precondition_failures` `[]`, `live_definition_sha256`
`1b805d53c7a00f90bf4341045b21f25893b3ddf2f56dd51b9a48ee2045a04bb7` and `function_acl`
`checksops EXECUTE`, `owner EXECUTE`: production's body without `PUBLIC`. The file keeps the ACL and
the intended fingerprint names `PUBLIC`, so the staging apply would miss it and roll back. Owner
decision 2026-10-30, "New combined fix": SQL 130 (`ops/production-sql-130-apply.md`) adds `code_check`
and revokes `PUBLIC` EXECUTE on this function, so both databases converge to one state.

**Status:** retired, never applied anywhere. The staging pin stays `execute: false` with a
retirement `authorization` (its read-live pre-state was never recorded); the production pin stays
pending. Do not apply SQL 129 in any environment. SQL 130 (`ops/production-sql-130-apply.md`)
replaces it.

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec
`sql129` in `release-sql-specs.mjs`). Intended
`8be5fa81be5451803fa2df179fd592862c69020ecdbe429a66834cec1e78b85e`:

```
release sql129 v1
function public.consume_financial_totp_rate_limit(uuid, text, integer, integer): lang=plpgsql vol=v parallel=u secdef=true result=TABLE(allowed boolean, count integer, retry_after_seconds integer) config=search_path=public, pg_temp prosrc=dbc080aabbcfe53da091c08f51bba1c88ad70593cddac4f7daa3ae224d32412e acl=PUBLIC EXECUTE;checksops EXECUTE;owner EXECUTE
```

**Expected pre-state.** The proposed file's function (body sha256
`0507b4474de7fb03ac843f44c2ad7bd06f603620905ab58b550d3b4e379b4d24`, equal to the `prosrc_sha256` the
production live inspect read) with EXECUTE for `PUBLIC`, `checksops` and the owner:
`37d945da85fb51e1cf532806171c1477f8d3701e2e41ed3aa259f54c7baf97b2` (derived from the proposed file's
bytes by `aws/tests/release-sql129-executor.test.mjs` and read back from a PostgreSQL 16 database
with that function loaded). Staging is not yet read: a different staging hash (for example no
`PUBLIC` grant) is not by itself a stop, but the per-function report and ACL must be read before
recording it, and the intended fingerprint names `PUBLIC`, so a staging ACL without it needs its own
reviewed decision before the staging apply (the file keeps the ACL, so on such a database the apply
misses the intended fingerprint and rolls back; covered on PostgreSQL 16 by the executor test).

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present` (`consume_financial_totp_rate_limit(uuid, text, integer, integer)`,
`financial_totp_rate_limits` with `user_id`, `action`, `window_started_at` and `request_count`, role
`checksops`); `functions_owned_by_login`; `function_results_match` (the `TABLE` result);
`function_acl_replaceable` (no EXECUTE grant outside `PUBLIC`, `checksops` and the owner).

Post-conditions: the intended fingerprint; the function owned by the login; everything else in schema
`public` (and the functions of `auth`) unchanged. The tools roll back otherwise.

## Steps

1. Staging: the staging executor must carry SQL 129 first (executor package refresh through the
   guarded staging executor `deploy` mode, its own reviewed run). Then run the guarded staging SQL
   executor with `read-live` for `sql129-financial-totp-rate-limit-code-check`. If it reports
   `prerequisites_missing` other than `[]` or `precondition_failures` other than `[]`, stop.
   Otherwise record `LIVE_DEFINITION_SHA256` in the staging pin (`expected_live_definition_sha256`,
   owner-approved `authorization`, `execute: true`) in a reviewed change, `apply`, then `read-live`
   again.
2. Production: run the read-only inspect on the runner
   (`node scripts/deployment-guard/production-sql-one-shot.mjs --migration sql129 … --phase inspect`);
   record `production_inspect` and copy `live_definition_sha256` into
   `expected_live_definition_sha256`; record the staging runs in `staging_acceptance`; set an
   owner-approved `authorization` and `execute: true`, in one reviewed change.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs
   --migration sql129 --approval-scope sql129 … --phase apply` with the owner's words
   (authorization phrase `APPLY_FINANCIAL_TOTP_RATE_LIMIT_CODE_CHECK`).
4. Record the apply and retire the pin (`execute: false`).
