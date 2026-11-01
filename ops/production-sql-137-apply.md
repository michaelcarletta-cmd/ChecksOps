# Production SQL 137 (the platform owner from the identity account only)

| key | file | what it does |
|---|---|---|
| `sql137` | `aws/workflows/sql/137_platform_owner_identity.sql` (sha256 `f1308cbdcb58ddcca23be9139dc32ebb28bc912ce5541327777a8027b843d5bb`) | Fail-closed preconditions (`sql137_table_missing`, `sql137_column_missing`, `sql137_function_missing`, `sql137_role_missing`, `sql137_owner_email_not_unique`, `sql137_owner_identity_count`, `sql137_owner_profile_without_identity`), then `CREATE OR REPLACE FUNCTION public.is_platform_owner()` with only the `identity_accounts` branch, its EXECUTE revoked from PUBLIC (and `anon`, `service_role` where they exist) and granted to `checksops, authenticated`, and `REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.identity_accounts FROM PUBLIC, checksops, authenticated` (and `anon` where it exists). No other statement: no `profiles` grant, no `is_master_owner()`, policy, column, index or row change. |

**Why.** Security audit 2026-10-29, finding 15 (medium, database access only). `is_platform_owner()`
(`aws/rls/sql/10_owner_helpers_from_identity.sql`; no later migration redefines it) is true when the
caller's `identity_accounts` row (status `active` or `isolated_test`) **or** the caller's `profiles`
row carries the platform-owner mailbox `checksopsadmin@gmail.com`. `checksops` (the API login) holds
table-level UPDATE on `profiles` (`aws/workflows/sql/66_staging_app_metadata_grants.sql`,
`aws/identity/sql/07_hire_mortgage_agent_grants.sql`) and, where `aws/identity/sql/07` ran, on
`identity_accounts`. A session with the `checksops` credentials could therefore make any user the
platform owner: one `UPDATE public.profiles SET email = 'checksopsadmin@gmail.com'`, or, on
`identity_accounts` (where `identity_accounts_email_lower_key` keeps the mailbox unique), by moving the
mailbox off the owner's row and onto its own. `is_master_owner()` delegates to it, so every
platform-owner policy and API gate (`IS_PLATFORM_OWNER_SQL`, `PLATFORM_OWNER_SQL` in
`aws/functions/api`) would follow.

**How the owner is identified (not changed).** The same mailbox on the same `identity_accounts` row,
bound to the application user the API resolved from the Cognito sub (`auth.uid()`). SQL 137 drops the
`profiles` branch and makes that row's email fixed for the API login; it does not introduce a new
owner identifier (an owner table, a pinned UUID or Cognito sub would be a separate owner decision).
The file refuses unless exactly one active/isolated_test identity row carries the mailbox and no
`profiles` row carries it outside that identity, so the user recognized before is the one recognized
after.

**What the API needs (read from the code).** No API path writes either email column. The API's
UPDATEs of `profiles` set only `full_name` / `phone` (`write-app-metadata.mjs` `executeProfiles`) and
`totp_enrolled_at` (`admin-reset-totp.mjs`); `profiles.email` is only inserted (`tenant-admin.mjs`,
the mortgage desk hire). `checksops` only reads and inserts `identity_accounts`
(`tenant-admin.mjs`: `INSERT ... ON CONFLICT (cognito_sub) DO NOTHING`, which needs no UPDATE); it is
updated only by the invite function (SQL 90 / SQL 101, SECURITY DEFINER, as its owner) and the
admin-login identity one-offs (`aws/identity/oneshot/onboard.mjs`, `aws/identity/sql/09`). Nothing
deletes or truncates it.

**Not changed.** `profiles`' grants: its email no longer decides `is_platform_owner()`; PostgreSQL
cannot revoke one column from a table-level UPDATE, so narrowing it means replacing the table grant
with a column list (a separate change). The API's own owner refusals (`USER_IS_PLATFORM_OWNER_SQL`,
`RESET_TOTP_TARGET_IS_PLATFORM_OWNER_SQL`) and the SQL 90 / SQL 101 / SQL 133 guards still also read
`profiles.email`: they only protect the owner (a match refuses), so a rewrite there cannot grant
anything. `is_master_owner()`, `identity_accounts`' SELECT and INSERT, every policy, column, index and
row.

**Residual (not this finding).** `auth.uid()` reads the session setting `request.app_user_id`
(`aws/identity/sql/02_auth_uid_guc.sql`), which any session can set: a holder of the `checksops`
credentials who knows the owner's application user id can still act as the owner. SQL 137 removes
the email routes only.

**Expected outcomes of the inspect.** `already_applied` false with `precondition_failures` `[]`, or
`already_applied` true (the function already identity-only with the pinned EXECUTE ACL, none of the
revoked table lines: nothing to apply; the inspect is recorded as the verified-live evidence and the
pin stays `execute: false`). Anything else (a precondition failure such as another role's EXECUTE on
the function, a missing table, column, index, function or role) stops and needs its own reviewed
change. The inspect reads no table rows, so the owner-row checks (`sql137_owner_identity_count`,
`sql137_owner_profile_without_identity`) are seen only by the apply, which then fails and rolls back.

**Staging executor refreshed (2026-10-31).** Inspect run 41233783836 (main `7d845915e`) found the live
executor at `kMYf1oP4mKP/zAPAREg0imlMC/cdheEWC8V5P9viUtg=` (LastModified 2026-10-31T15:55:22Z,
`executor_current` false) without `sql/137_platform_owner_identity.sql` (main's package also
superseded `lib/release-sql-specs.mjs`, `lib/release-sql-state.mjs` and `lib/sql-executor-auth.mjs`).
Deploy run 41234041020 (main `7d845915e89c6ea21b98a0ed720c93a871b974aa`,
`expected_executor_code_sha256` `kMYf1oP4…` matched) updated `checksops-staging-guarded-sql-executor`
to main's package (`m30FadRmX2njQ2GTbBbysuzIG99OyHxXIIFu2OL2uZ4=`, RevisionId
`e6b92528-c9bb-41c6-a499-13e00d67ee2d`, LastModified 2026-10-31T19:26:03Z).

**Staging read-live (2026-10-31).** Run 41234275408 (main `7d845915e`, executor `m30FadRm…`, pin
commit `556626cb5`): `is_platform_owner()` state `different`, its EXECUTE ACL `PUBLIC EXECUTE`,
`authenticated EXECUTE`, `checksops EXECUTE`, `owner EXECUTE`; `identity_accounts` holds
`checksops UPDATE` (`other_write_grants` `[]`). Live
`a2c2d856a21c52d47544fad05e0f0275a24a093421c8a7a7fbeea0e4bb329dfc`, intended `9a88fca2…`,
`already_applied` false, `precondition_failures` `[]`, `prerequisites_missing` `[]`, `mutation` false.

**The staging pre-state is not the predicted one.** The prediction below (`7349393d…`,
`aws/rls/sql/10`'s body with these grants) does not match the live value. The grants the run reported
are the predicted ones, so the live `is_platform_owner()` definition is not `aws/rls/sql/10`'s (the
read-live prints its fingerprint, not its body; neither Supabase-era body in `supabase/migrations`,
`20260830114402_…` or `20260910130000_restrict_platform_owner_to_checksops_admin.sql`, reproduces it
with these grants either). SQL 137 replaces the whole function (`CREATE OR REPLACE`), so the live body
is overwritten; the engine's preconditions passed on it, and the apply still checks the owner rows
(`sql137_owner_identity_count`, `sql137_owner_profile_without_identity`) and rolls back if they fail.
Told this, the owner chose to record the read-live value. Recorded in the staging pin
(`expected_live_definition_sha256`, `execute: true`, wave 32) under the owner's words of 2026-10-31,
"record the SQL 137 staging pin". The staging apply itself is a separate run after this pin is merged,
on the owner's words for that run. Production is read by its own inspect; the production prediction
(`9862a392…`) may differ in the same way.

**Staging executor refreshed for the pin (2026-10-31).** The staging pin (wave 32, PR #1499) merged
as `41827fcc42eb00cfe8591087aab3fc8ea798c648`. Inspect run 41236403102 (main `41827fcc4`) found the
live executor at `m30FadRmX2njQ2GTbBbysuzIG99OyHxXIIFu2OL2uZ4=` (`executor_current` false; main's
package superseded `lib/sql-executor-auth.mjs` only). Deploy run 41236640767
(`expected_executor_code_sha256` `m30FadRm…` matched) updated `checksops-staging-guarded-sql-executor`
to main's package (`sIf1rFWcrsTF2+B9dYSRe1c6Ydn1qI+V/8o8lG5ceXE=`, RevisionId
`efe8b01a-0ab2-4eb1-97c5-603a0db0e007`, LastModified 2026-10-31T20:00:13Z).

**Staging apply (2026-10-31).** Apply run 41236898030 (main `41827fcc4`, executor `sIf1rFWc…`,
`executor_current` true, pin commit `556626cb5`, `expected_live_definition_sha256`
`a2c2d856a21c52d47544fad05e0f0275a24a093421c8a7a7fbeea0e4bb329dfc`): success. The receipt
(job 124642458662) prints `result` `applied`, `before_hash` `a2c2d856…`, `after_hash`
`9a88fca29d21f5537052f475f4133f05e89e002bdf00b22cfc3cf2cf78c6d8da`, `executor_identity`
`checksops-staging-guarded-sql-executor`; `is_platform_owner()` in state `intended` with EXECUTE for
`authenticated`, `checksops` and the owner only (no `PUBLIC EXECUTE`), and `identity_accounts`
holding no `UPDATE`, `DELETE` or `TRUNCATE` grant (`other_write_grants` `[]`). The apply's owner-row
checks (`sql137_owner_identity_count`, `sql137_owner_profile_without_identity`) passed. Read-live
run 41237134081 (main `41827fcc4`): `already_applied` true, `live_definition_sha256` `9a88fca2…`
equal to the intended hash, `precondition_failures` `[]`. Staging acceptance: the owner reported on
2026-11-01 "SQL 137 works in staging" (signed in on staging as the platform owner and loaded
`/admin/tenants`, the platform-owner tenant list that `is_platform_owner()` gates). The staging pin
keeps `execute: true`; the staging runs are recorded in the production pin's `staging_acceptance`
by the production pin PR.

**Production inspect (2026-11-01).** Read-only `--inspect` through SSM
`9d865a2c-c032-4f8c-8d81-d7420e6edb90` on `i-0c35557c4e5385406` (started 2026-11-01T01:42:05Z under the
owner's words "start the SQL runner for the SQL 137 production inspect", stopped again 01:43:46Z), main
`6120c6480` (tarball sha256 `4c70eed24bb1448fe652cc6b10e0a486a18cc2313d8492c5e4721122606b4572`, transfer
run 41261427070, migration source `f1308cbd…` == pin), connected as `checksops_admin`:
`is_platform_owner()` `different`, its EXECUTE ACL `PUBLIC EXECUTE`, `checksops EXECUTE`, `owner EXECUTE`
(no `authenticated EXECUTE`: signed-in callers reach it through PUBLIC); `identity_accounts` holds
`checksops DELETE` and `checksops UPDATE` (`other_write_grants` `[]`); every prerequisite present;
`predecessors` `{}`; live `15fecb5b913a30860ae5fc03d58b4108c27f1692c07b5edf2f90e0a9f9b1c095`,
`already_applied` false, `precondition_failures` `[]`.

**The production pre-state is neither the predicted one nor staging's.** The prediction (`9862a392…`,
`aws/rls/sql/10`'s body with EXECUTE for PUBLIC, authenticated, checksops and the owner and no write grant
on `identity_accounts`) and staging's recorded pre-state (`a2c2d856…`) both differ. `aws/rls/sql/10`'s body
with the grants this inspect reports fingerprints as `cbf76897…`, so production's function definition is
not `aws/rls/sql/10`'s either (the inspect prints its fingerprint, not its body). SQL 137 replaces the whole
function and sets its ACL and the `identity_accounts` grants explicitly, so it reaches the intended state
(`9a88fca2…`) that staging reached; it also removes production's `checksops DELETE`, which staging never
had. No API code updates or deletes `identity_accounts`. Told this, the owner chose on 2026-11-01 to record
the read value ("Merge 1591 and I choose option A"; 1591 read as #1501). Recorded in the production pin
with the staging apply (run 41236898030) as its staging acceptance and `execute: true`; the owner's words
so far name the staging steps, the inspect and this pin, not the production apply. The owner merges the
pin change; the apply still needs the owner's words for that run and runs only after that merge is on main
and staged. A fresh inspect immediately before the apply must still report `15fecb5b…`; the apply's
owner-row checks (`sql137_owner_identity_count`, `sql137_owner_profile_without_identity`) roll it back if
they fail.

**Production apply (2026-11-01).** After the pin change (#1502, merged to main as `e8ef1f52d` on the
owner's "Merge 1502 and A"), transfer run 41263811958 staged main `e8ef1f52d` (tarball sha256
`af52eb51781970da1b36757c9dc4e120d989cf2c96626ac8d93159486dba0552`). Under the owner's words
"apply SQL 137 in production" (passed verbatim), a one-shot `--phase inspect` (SSM `b5f541cd-6eaf-4c26-88ef-d49270f9b458`,
run `a9ce8db7-5df5-47d8-8d22-7961c8032341`, nothing written) read live `15fecb5b…` (the pinned pre-state,
`live_matches_expected` true, `apply_preconditions_met` true, `precondition_failures` `[]`); then one-shot
`--phase apply` run `a7cd33a1-855c-43f4-aa52-58f196dea7cc` through SSM `217d0d6a-c505-40ff-9808-12f9bf21ccba`,
workstream `prod-sql137-platform-owner-identity-20261101`, one_use_id
`sql137-prod-bff421b2-1636-4a3e-9a71-bc51f7157b49`: its own inspect step read the same pre-state; contracts
4/4, 6/6 and 43/43; every step ok; manifest `ae572838…`; the file's owner-row checks
(`sql137_owner_identity_count`, `sql137_owner_profile_without_identity`) passed; receipt `15fecb5b…` →
`9a88fca29d21f5537052f475f4133f05e89e002bdf00b22cfc3cf2cf78c6d8da` (intended), result `applied`, unrelated
catalog `762c2754…` (functions 1355, triggers 184); post-apply inspect `already_applied` true,
`precondition_failures` `[]`: `is_platform_owner()` `intended` with EXECUTE for `authenticated`,
`checksops` and the owner (PUBLIC revoked), and `identity_accounts` with no `UPDATE`, `DELETE` or
`TRUNCATE` line (production's `checksops DELETE` and `checksops UPDATE` removed). The run's JSON arrived
whole (19698 characters, under SSM's 24000-character limit). Runner state: started from stopped at
2026-11-01 11:17:58 UTC (SSM online 11:18:14 UTC) and stopped again at 11:20:00 UTC. Production
acceptance: the owner reported on 2026-11-01 "Admin tenants works in production, record SQL 137" (signed
in as the platform owner and loaded `/admin/tenants`).

**Status:** applied to staging (wave 32) and to production (2026-11-01); the production pin is retired
(`execute: false`).

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec
`functions` and `table_privileges` in `release-sql-specs.mjs`; `table_privileges` with `intended: []`
as SQL 106): the function as the file leaves it, and the UPDATE / DELETE / TRUNCATE lines of PUBLIC,
`anon`, `authenticated` and `checksops` on `identity_accounts`. Intended
`9a88fca29d21f5537052f475f4133f05e89e002bdf00b22cfc3cf2cf78c6d8da`:

```
release sql137 v1
function public.is_platform_owner(): lang=sql vol=s parallel=u secdef=true result=boolean config=row_security=off;search_path=public prosrc=d64eb9034ad6518a06fc06dd4c910cafee07824cbf577f212546c0d24058cd68 acl=authenticated EXECUTE;checksops EXECUTE;owner EXECUTE
privileges public.identity_accounts UPDATE,DELETE,TRUNCATE: 
```

**Expected pre-states (not recorded anywhere yet; each pin records its own environment's read).**
Derived by `aws/tests/release-sql137-executor.test.mjs` and read back from a PostgreSQL 16 database
with the repository's files (`aws/rls/sql/10`'s body, prosrc
`1747dc257d373bd94383c6bd2043c9022ab4c2221eabb16a2e070956b0872c3d`, and `aws/rls/sql/15`'s EXECUTE
grants on top of PUBLIC's default):

- no UPDATE, DELETE or TRUNCATE on `identity_accounts` for the four roles (`aws/identity/sql/03`'s
  SELECT only; production's expected state):
  `9862a392054d3adb7069949dac490f6423be86632abf0ac9d9d6c99d81ffdada`.
- the same plus `aws/identity/sql/07`'s `checksops UPDATE` (staging's expected state):
  `7349393da7ae7f94cd63f6796c76c5df2686f5274b84d7f6ad4a6ea405021f37`.

The live body or ACL may differ (a Supabase-era body, `anon` or `service_role` EXECUTE); the
inspect reads them. Neither value is written into a pin before a run reads it. Every other grant on
`identity_accounts` (SELECT, INSERT, the owner's) must be unchanged (`other_table_privileges_unchanged`);
its column ACLs, `profiles`, `is_master_owner()` and everything else are in the unrelated-catalog
snapshot.

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

Engine: `prerequisites_present` (the two tables, `identity_accounts_email_lower_key`, `auth.uid()`,
`is_platform_owner()`, the five columns, roles `checksops` and `authenticated`);
`altered_relations_owned_by_login` and `functions_owned_by_login` (the login owns the table and the
function); `function_results_match` (boolean); `function_acl_replaceable` (every live EXECUTE grant
is a kept line or PUBLIC, `anon` or `service_role`, which the file revokes). The file adds the
unique lower(email) index check and the owner-row checks above. No predecessor.

Post-conditions: the intended fingerprint; the other grants on `identity_accounts` unchanged;
everything else in schema `public` (and the functions of `auth`) unchanged, the function excepted.
The tools roll back otherwise.

## Order

No predecessor and no order. No Lambda or SPA change goes with it: every API owner check calls
`is_platform_owner()` / `is_master_owner()` and keeps its result for the owner. After the staging
apply, sign in on staging as the platform owner and open a platform-owner page (tenant management)
to confirm the owner is still recognized.

## Steps

1. Staging: the staging executor must carry SQL 137 first (executor package refresh through
   `sql-executor-ensure.mjs` / the guarded staging executor `deploy` mode, its own reviewed run).
   Then run the guarded staging SQL executor with `read-live` for
   `sql137-platform-owner-identity`. Expected: `already_applied` false,
   `precondition_failures` `[]`. Read its `release_sql_inspect.functions` and
   `release_sql_inspect.privileges` either way. If it reports `already_applied` true, record the run
   as the staging evidence (nothing to apply). If it reports `prerequisites_missing` other than `[]`
   or `precondition_failures` other than `[]`, stop. Otherwise record `LIVE_DEFINITION_SHA256` in
   the staging pin (`expected_live_definition_sha256`, owner-approved `authorization`,
   `execute: true`) in a reviewed change, `apply` with the owner's approval of that run, then
   `read-live` again (expected `already_applied` true). If the apply fails with
   `sql137_owner_identity_count` or `sql137_owner_profile_without_identity`, stop and report the
   count: the owner decides.
2. Production: run the read-only inspect on the runner
   (`node scripts/deployment-guard/production-sql-one-shot.mjs --migration sql137 … --phase inspect`,
   or the tool's `--inspect`); record `production_inspect`. If `already_applied` is true, the
   reviewed change records it as verified live and leaves `execute: false`. Otherwise copy
   `live_definition_sha256` into `expected_live_definition_sha256`, record the staging runs in
   `staging_acceptance`, and set an owner-approved `authorization` and `execute: true`, in one
   reviewed change.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs
   --migration sql137 --approval-scope sql137 … --phase inspect`, then the owner-named
   `--phase apply` with the owner's words (authorization phrase
   `APPLY_PLATFORM_OWNER_IDENTITY`).
4. Record the apply and retire the pin (`execute: false`).
