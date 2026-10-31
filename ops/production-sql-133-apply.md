# Production SQL 133 (teammate reset of a financial TOTP enrollment)

| key | file | what it does |
|---|---|---|
| `sql133` | `aws/workflows/sql/133_financial_totp_admin_reset_enrollment.sql` (sha256 `2184701c42869cef45839bb68aec7a8275f303612576d426225d172d54c8e9a2`) | Refuses without the financial TOTP enrollment, tenant membership and identity schema (`55000 sql133_prerequisite_missing`) or when the applying login could not reach one of the four relations as a DEFINER owner past RLS (`55000 sql133_definer_cannot_reach`). Then `CREATE OR REPLACE` of the new `financial_totp_admin_reset_enrollment(uuid, uuid)` (`plpgsql`, `VOLATILE`, `SECURITY DEFINER`, `search_path = public, pg_temp`, `RETURNS TABLE(cleared boolean)`), `REVOKE ALL ... FROM PUBLIC` and `GRANT EXECUTE ... TO checksops` on it. No other statement. |

**Why.** A verified financial TOTP enrollment can never be replaced: `handleMfaAssociate`
(`aws/functions/api/auth-financial-totp.mjs`) answers 409 `enrollment_reset_required` when the row has
`verified_at`, and `financial_totp_upsert_enrollment` raises `verified_enrollment_exists`. The only
reset path, the teammate reset (`aws/functions/api/admin-reset-totp.mjs`, route `admin-reset-totp`,
User Management "Reset two-factor authentication"), needs the caller's own fresh `team.reset_totp`
step-up, refuses self and the platform owner, then clears the Cognito factor
(`AdminSetUserMFAPreference`) and `profiles.totp_enrolled_at`, but never the
`public.financial_totp_enrollments` row: the API connects as `checksops`, which holds no privilege on
that table (`aws/migrations/proposed/NOT_APPLIED_20260911_financial_totp_enrollment.sql`, the live
definition per the read-only financial TOTP inspect of production on 2026-10-30, SSM
`cfee4512-4988-4fd1-be77-b03d1b4cd50b`), and no `financial_totp_*` function deletes a row or clears
`verified_at`. So the button leaves the authenticator enrolled, the teammate's next enrollment still
gets the 409, and a user who lost the phone has no way back in. Owner 2026-10-30: "ok build the reset
after SQL 131 and the lockout fix".

**What it changes.** One new function, `financial_totp_admin_reset_enrollment(p_actor_user_id uuid,
p_target_user_id uuid)`. The API calls it once per teammate reset, after its own checks and after it
has consumed the caller's step-up, inside the same transaction and before it touches Cognito. The
database enforces the API's rules again (defense in depth); each refusal is an exception, so nothing
is deleted:

- both ids present (`22023 invalid_reset`); `p_actor_user_id = auth.uid()` (`42501
  enrollment_caller_mismatch`): the caller acts only as itself;
- actor != target (`42501 cannot_reset_own_totp`): a login that lost its second factor, or a stolen
  session, cannot drop its own;
- the target shares one of the actor's tenants (`42501 reset_target_not_teammate`): the API's
  `RESET_TOTP_TEAMMATE_SQL`, the same `tenant_users` self-join, the role column not read;
- the target is not the platform owner (`42501 platform_owner_protected`): the API's
  `RESET_TOTP_TARGET_IS_PLATFORM_OWNER_SQL`, `identity_accounts` or `profiles` email
  `checksopsadmin@gmail.com`; the owner's own recovery stays a one-off guarded migration;
- then `DELETE` of the target's `financial_totp_enrollments` row; `cleared true` when a row was
  deleted, `cleared false` when the target had none (idempotent, no error).

Deleting the row (rather than clearing `verified_at`) also drops the secret, the used timestep and
SQL 132's `failed_attempts` / `locked_until`, so the teammate's next enrollment starts clean through
`financial_totp_upsert_enrollment`. The function never returns the secret, nonce, key id or any
timestamp. The reset is recorded by the API's step-up consumption row (`financial_stepup_log`, action
`team.reset_totp.consumed`, `metadata.target_user_id`), which commits in the same transaction; the
function writes no log row of its own (SQL 97 and SQL 106 keep that table server-written and
append-only, and a second row would say nothing the consumption row does not).

EXECUTE: revoked from `PUBLIC` (a new function is otherwise executable by every login), granted to
`checksops` (the API login); the owner keeps its own. The ACL is `checksops` and the owner, as the
proposed file's functions, SQL 130, SQL 131 and SQL 132 leave theirs.

Not changed: no table, column, policy, RLS setting, table grant, trigger or row; no other function
(`financial_totp_get_enrollment`, `financial_totp_mark_verified`, `financial_totp_upsert_enrollment`,
`financial_totp_status`, SQL 130's `consume_financial_totp_rate_limit`, SQL 132's
`financial_totp_count_code_check`) and none of their ACLs. No self-service reset: a user cannot reset
their own enrollment through this function or any other path. The platform owner stays protected. No
lockout or replay change. No API, Lambda or SPA change is part of this file or its pins: the API change
that calls the function (`aws/functions/api/admin-reset-totp.mjs`) tolerates its absence (the Cognito
and `profiles` reset as before, `financialTotpCleared false`, never a 500) and is deployed through the
guarded Lambda path after SQL 133 is applied in that environment. No trigger is added.

**Predecessor.** None: SQL 133 calls none of SQL 130, 131 or 132's functions. It follows them by the
order of work the owner set ("after SQL 131 and the lockout fix"), not by an engine gate.

**Staging executor refreshed (2026-10-30).** Inspect run 41128753561 (main `564b7baee`) found the live
executor at `aBuDhgGl…` (LastModified 2026-10-30T19:38:33Z, `executor_current` false) without
`sql/133_financial_totp_admin_reset_enrollment.sql` and `sql/134_loss_draft_escrow_write_grants.sql`
(main's package also superseded `lib/release-sql-specs.mjs`, `lib/release-sql-state.mjs` and
`lib/sql-executor-auth.mjs`). Deploy run 41129102846 (main `564b7baeef67a7078334ad3ad6d112a3e75531dd`,
`expected_executor_code_sha256` `aBuDhgGl…` matched) updated `checksops-staging-guarded-sql-executor` to
main's package (`0RDcYqTSW+3Ylm4Bbjk8cbHToxs/Rgp0Ip57BRIdzu0=`, RevisionId
`85896645-1c14-46aa-bbbe-697dd086a731`, previous `40d85b6c-5982-423c-8aa7-e130cb2ac47d`; `result`
`applied`, `mutation` false).

**Staging read-live (2026-10-30).** Run 41129536538 (main `564b7baeef67a7078334ad3ad6d112a3e75531dd`,
executor `0RDcYqTS…`): `financial_totp_admin_reset_enrollment(uuid, uuid)` absent (`function_acl` `[]`);
every prerequisite present (`prerequisites_missing` `[]`); `predecessors` `{}`; the definer writes on
`financial_totp_enrollments`, `tenant_users`, `identity_accounts` and `profiles` all ok; live
`f3b1671e8617df78a20600b43fcfc6636739d78f235ef78d1cc7d1d68f2f909d` (the pre-state derived above, the
function absent), intended `edfef132…`, `already_applied` false, `precondition_failures` `[]`,
`mutation` false. Recorded in the staging pin (`expected_live_definition_sha256`, `execute: true`,
wave 30) under the owner's words of 2026-10-30, "continue with SQL 133 staging". The staging apply
itself waits for the owner's words for that run.

**Staging apply (2026-10-30).** Run 41133471065 (main `746074fb1b8f799b6cd413ccf9e4e7fad5694c0d`, staging
pin PR #1470, on the executor deployed by run 41133133498, `PPZJFH/U…`, RevisionId
`c8196e9e-fb64-41d3-bdf2-1f7fd6ea0911`, previous `9kXHUCcy…` / `26f2a3a0-b94d-45a3-8c18-6749b2121682`;
workstream `github-staging-sql-41133471065`) under the owner's words "apply SQL 133 in staging": receipt
before `f3b1671e8617df78a20600b43fcfc6636739d78f235ef78d1cc7d1d68f2f909d`, after
`edfef132ffea2b00a1b22e452b35a4232a14c81fbba832325d22ce8656a45459` (intended), result `applied`;
`financial_totp_admin_reset_enrollment(uuid, uuid)` `intended`, `function_acl` `checksops EXECUTE` and
`owner EXECUTE`, `definer_writes` ok. Read-live run 41133803430: `already_applied` true, live
`edfef132…`, `precondition_failures` `[]`.

**Production inspect (2026-10-30).** Read-only `--inspect` through SSM
`a28009c3-db1c-4567-b7b6-7fe01f7d06f4` on `i-0c35557c4e5385406`, main `746074fb1` (tarball sha256
`0445edb2fc3ce505fe08c9d9d770e13a27ed456f31af52af1b1b904293fc1ab4`, transfer run 41147257903, migration
source `2184701c…` == pin), connected as `checksops_admin`: `financial_totp_admin_reset_enrollment(uuid,
uuid)` `absent` (`function_acl` `[]`); every prerequisite present; `predecessors` `{}`; the definer
writes on `financial_totp_enrollments`, `tenant_users`, `identity_accounts` and `profiles` all ok; live
`f3b1671e8617df78a20600b43fcfc6636739d78f235ef78d1cc7d1d68f2f909d`, `already_applied` false,
`precondition_failures` `[]`. That is the pre-state derived above (the function absent), the same one
staging had, so the staging apply took the path production will
(`aws/tests/sql133-financial-totp-admin-reset-pg.test.mjs`). Recorded in the production pin with the
staging apply as its staging acceptance and `execute: true`; the owner's words so far ("ok build the
reset after SQL 131 and the lockout fix", "Merge 1467 and 1466", "continue with SQL 133 staging", "apply
SQL 133 in staging", "merge 1470", "run the SQL 133 production inspect") name the build, the merges, the
staging step and the inspect, not the production apply. The owner merges the pin change; the apply still
needs the owner's words for that run and runs only after that merge is on main and staged.

**Status:** applied to staging (wave 30); production pin execute-authorized; not applied to production.

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec
`sql133` in `release-sql-specs.mjs`). Intended
`edfef132ffea2b00a1b22e452b35a4232a14c81fbba832325d22ce8656a45459`:

```
release sql133 v1
function public.financial_totp_admin_reset_enrollment(uuid, uuid): lang=plpgsql vol=v parallel=u secdef=true result=TABLE(cleared boolean) config=search_path=public, pg_temp prosrc=4553c69d664f3ee590be5967e88ea04f81ea1c61b411d50a027e0dfa2406a5db acl=checksops EXECUTE;owner EXECUTE
```

**Expected pre-state (both environments).** The function absent, everything else in place:

```
release sql133 v1
function public.financial_totp_admin_reset_enrollment(uuid, uuid): absent
```

That is `f3b1671e8617df78a20600b43fcfc6636739d78f235ef78d1cc7d1d68f2f909d`, derived by
`aws/tests/release-sql133-executor.test.mjs` and read back from a PostgreSQL 16 database with the
proposed file loaded. Each pin records its own environment's read; neither value is written into a pin
before a run reads it. A pre-state other than this one is not by itself a stop, but its per-function
report and ACL must be read and explained before it is recorded.

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present` (`financial_totp_enrollments` with `application_user_id`, `tenant_users` with
`tenant_id` and `user_id`, `identity_accounts` with `application_user_id` and `email`, `profiles` with
`id` and `email`, `auth.uid()`, role `checksops`); `definer_can_write_relations` on all four relations
(the applying login owns each without `FORCE ROW LEVEL SECURITY`, or is a superuser or `BYPASSRLS`: the
function deletes from the first and reads the other three for its gate, and a gate filtered by RLS
would refuse every reset or let one through on a partial view); and, where the function already exists
(a re-run), `functions_owned_by_login`, `function_results_match` (the `TABLE` result) and
`function_acl_replaceable` (no EXECUTE grant outside `checksops` and the owner, which the file keeps,
and `PUBLIC`, which it revokes).

Post-conditions: the intended fingerprint; the function owned by the login; everything else in schema
`public` (and the functions of `auth`) unchanged. The tools roll back otherwise.

## Steps

1. Staging: the staging executor must carry SQL 133 first (executor package refresh through the
   guarded staging executor `deploy` mode, its own reviewed run). Then run the guarded staging SQL
   executor with `read-live` for `sql133-financial-totp-admin-reset-enrollment`. Expected:
   `already_applied` false, `precondition_failures` `[]`, `definer_writes` all `ok true`,
   `live_definition_sha256` `f3b1671e…` (above). If it reports `prerequisites_missing` other than
   `[]` or `precondition_failures` other than `[]`, stop. Otherwise record `LIVE_DEFINITION_SHA256`
   in the staging pin (`expected_live_definition_sha256`, owner-approved `authorization`,
   `execute: true`) in a reviewed change, `apply`, then `read-live` again.
2. Production: run the read-only inspect on the runner
   (`node scripts/deployment-guard/production-sql-one-shot.mjs --migration sql133 … --phase inspect`);
   record `production_inspect` and copy `live_definition_sha256` into
   `expected_live_definition_sha256`; record the staging runs in `staging_acceptance`; set an
   owner-approved `authorization` and `execute: true`, in one reviewed change.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs
   --migration sql133 --approval-scope sql133 … --phase apply` with the owner's words
   (authorization phrase `APPLY_FINANCIAL_TOTP_ADMIN_RESET`).
4. Record the apply and retire the pin (`execute: false`).
5. Only then deploy the API change through the guarded Lambda path
   (`ops/lambda-configuration-change.md`, `ops/production-lambda-rebuild.md`); until then the API
   finds no `financial_totp_admin_reset_enrollment` and behaves as before SQL 133 (Cognito and
   `profiles` reset only, `financialTotpCleared false`).
