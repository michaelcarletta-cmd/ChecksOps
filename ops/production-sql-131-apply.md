# Production SQL 131 (the four financial TOTP enrollment functions, no `PUBLIC` EXECUTE)

| key | file | what it does |
|---|---|---|
| `sql131` | `aws/workflows/sql/131_financial_totp_functions_no_public.sql` (sha256 `e7b5a8dfb70fda9226356a463ff25acf373a7c891321f55a53d8a92051546217`) | After checking that the four functions and the role `checksops` exist (55000 `sql131_prerequisite_missing`) and that the login owns each of them (42501 `sql131_not_function_owner`): `REVOKE EXECUTE ... FROM PUBLIC` and `GRANT EXECUTE ... TO checksops` on `public.financial_totp_upsert_enrollment(uuid, bytea, bytea, text)`, `public.financial_totp_get_enrollment(uuid)`, `public.financial_totp_mark_verified(uuid, bigint)` and `public.financial_totp_status(uuid)`. Nothing else. |

**Why.** The read-only financial TOTP live inspect of production (2026-10-30, SSM
`cfee4512-4988-4fd1-be77-b03d1b4cd50b`, main `da064a34`, `ops/security/FINANCIAL_TOTP_LIVE_INSPECT.md`)
read the financial TOTP functions as `SECURITY DEFINER` (`search_path = public, pg_temp`), owned by
`checksops_admin`, with EXECUTE for `PUBLIC`, `checksops` and the owner, their bodies equal to
`aws/migrations/proposed/NOT_APPLIED_20260911_financial_totp_enrollment.sql`. With `PUBLIC`, any
database login can call them directly, outside the API. SQL 130 (`ops/production-sql-130-apply.md`,
applied to staging and production on 2026-10-30) removed `PUBLIC` from the fifth function,
`consume_financial_totp_rate_limit(uuid, text, integer, integer)`, and left the other four to "a
separate migration". Owner 2026-10-30: "restart SQL 131 and the lockout fix". This file is that
migration for the four; the lockout fix is a separate change.

**Nobody loses access.** The only callers are the API Lambda, which connects as `checksops`
(`aws/functions/api/data.mjs` `withIdentity` / `withIdentityWrite`; `aws/functions/api/db-health.mjs`
`EXPECTED_APPLICATION_ROLE = 'checksops'`): `aws/functions/api/auth-financial-totp.mjs` calls all four
(`financial_totp_status` at line 145, `financial_totp_get_enrollment` at line 154,
`financial_totp_upsert_enrollment` at line 239, `financial_totp_mark_verified` at line 298) and
`aws/functions/api/providers/production/checkalt-register.mjs` calls `financial_totp_get_enrollment`
and `financial_totp_mark_verified` (lines 226 and 227). No SQL function, view, policy, trigger or job in
the repository calls them (`grep -rn financial_totp_` over `aws/`, `supabase/` and `scripts/` finds only
the proposed file, the API, the live inspect and the tests). `checksops` and the owner keep EXECUTE.

**The GRANT.** Each `REVOKE ... FROM PUBLIC` is paired with `GRANT EXECUTE ... TO checksops`, as the
functions' own proposed file and SQL 130 pair them. `checksops` already holds EXECUTE in both databases,
so the GRANT changes nothing there; it makes the state the file leaves one fixed fingerprint (EXECUTE for
`checksops` and the owner) from any accepted starting ACL.

Not changed: the functions' bodies, `SECURITY DEFINER`, `search_path`, results and owners;
`consume_financial_totp_rate_limit` (SQL 130's); any table, column, policy, RLS setting, table grant,
trigger or row; the lockout behavior. No API, Lambda or SPA change is part of this file or its pins. No
trigger is added.

**Staging executor refreshed (2026-10-30).** Inspect run 41107092402 (main `6f7357af`) found the live
executor at `5OmSJSao…` without `sql/131_financial_totp_functions_no_public.sql`. Deploy run
41107423198 updated it to main's package (`jOd0IqUJQWAawRveO44q7mLIxYP2iqmwtFgiebyMQ2M=`, RevisionId
`d6814564-30a0-4ead-9eb8-3a3534c26a84`).

**Staging read-live (2026-10-30).** Run 41107844336 (main `6f7357afbdd85ccd23a3c609164a1a4d0a15541f`,
executor `jOd0IqUJ…`): the four functions `intended`, EXECUTE for `checksops` and the owner only
(`checksops EXECUTE grantor=owner`, `owner EXECUTE grantor=owner`); every prerequisite present
(`prerequisites_missing` `[]`); `predecessors.sql130` true; live
`a661533320d9b391cc9b5c5f2fade5632801060693a5205c4bf8391702fe90c7` (the intended state),
`already_applied` true, `precondition_failures` `[]`. Staging never held `PUBLIC` on the four (the
proposed-file load there revoked it), so there was nothing to apply: no staging apply was run, this
read-live is the staging acceptance and the staging pin stays pending, as SQL 119's did.

**Production inspect (2026-10-30).** Read-only `--inspect` through SSM
`be25e88a-1088-49af-81fa-10eecd8902b4` on `i-0c35557c4e5385406`, main `1dcd0f33e` (tarball sha256
`1d9efa200afe912ace7feb0455204b661d076b0012682fe17a46c65f6f4c8968`, transfer run 41108283066, migration
source `e7b5a8df…` == pin), connected as `checksops_admin`: the four functions `different`, each with
ACL `PUBLIC EXECUTE grantor=owner`, `checksops EXECUTE grantor=owner`, `owner EXECUTE grantor=owner`;
every prerequisite present; `predecessors.sql130` true; live
`99d9e8e925ca8c5b56e11409f145e2d75de2759c27d8fd1b476494ffc62e2eaa`, `already_applied` false,
`precondition_failures` `[]`. That is the production pre-state derived below from the spec; it differs
from staging's (the intended state) only by the `PUBLIC` EXECUTE grant on each of the four, which the
file revokes (`aws/tests/sql131-financial-totp-functions-pg.test.mjs` applies from both pre-states).
Recorded in the production pin with the staging read-live as its staging acceptance and `execute: true`
under the owner's words of 2026-10-30 ("restart SQL 131 and the lockout fix", "Merge SQL 131 and the
lockout fix when green", "continue with SQL 131 staging", "run the SQL 131 production inspect"; no words
for the production apply yet). The owner merges the pin change; the apply still needs the owner's
run-time approval and runs only after that merge is on main and staged.

**Production apply (2026-10-30).** After the pin change (#1460, merged to main as `546dd7cb8` on the
owner's "merge the SQL 131 pin when green"), transfer run 41113179289 staged main `546dd7cb8` (tarball
sha256 `becdc3771311f1d4e4120e0cda0e1dfa88fb0fa45e3b83f3928a30cdd0f8468c`). A read-only one-shot
`--phase inspect` of the same commit (SSM `e63078b3-fc50-45ee-8ccc-066559e25c88`, run
`f7f6e63b-ad8c-4c03-8a5d-fe3ca90dff29`) found live `99d9e8e9…` (the pinned pre-state), the four functions
`different` with `PUBLIC`, `predecessors.sql130` true, `precondition_failures` `[]`, contracts 4/4, 6/6 and
43/43. One-shot `--phase apply` run `5e1711ea-5181-42f7-83a4-cd340a50641a` through SSM
`decffaaa-25d2-4665-b6ee-f243fe459062`, workstream `prod-sql131-financial-totp-functions-no-public-20261030`,
under the owner's words "apply SQL 131 in production" (passed verbatim): every step ok; manifest
`1a3cad1d…`; receipt `99d9e8e9…` → `a661533320d9b391cc9b5c5f2fade5632801060693a5205c4bf8391702fe90c7`
(intended), result `applied`, unrelated catalog `eda4f4ea…` (functions 1350, triggers 184); post-apply
inspect `already_applied` true, `precondition_failures` `[]`. SSM returned the first 24000 characters of the
command's output, which cut the one-shot JSON inside its `applied.post_apply_inspect`; the pin records the
run's top-level `post_apply_inspect` (the same object, printed whole) and says so in `applied.one_shot_note`.
A separate read-only inspect (SSM `57285e9d-c4b6-4397-ab9f-82c426a15520`) reported the four functions
`intended`, EXECUTE for `checksops` and the owner only (`PUBLIC` revoked). Runner state: started for these
runs at 2026-10-30 19:16:14 UTC and stopped at 19:17:41 UTC.

**Status:** staging already in the intended state (no apply); applied to production (2026-10-30); the
production pin is retired (`execute: false`).

## Order

Predecessor `sql130` (spec `predecessors`, pin `predecessors`): the inspect reports `predecessors.sql130`
true only while `consume_financial_totp_rate_limit` is in SQL 130's intended state, which it is in both
databases since 2026-10-30. SQL 131 does not read or change SQL 130's function; the predecessor records
the order the owner chose (SQL 130 first, then SQL 131). Nothing in the release names SQL 131 as its
predecessor, supersedes it or refuses after it. `production-api-overlay-plan.json` has no entry for
SQL 131: it holds no Lambda member.

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec
`acl_functions` in `release-sql-specs.mjs`, `render.grantors`, no `attributes`): each function's EXECUTE
ACL with each entry's grantor (the owner read as `owner`), or `absent`. Intended
`a661533320d9b391cc9b5c5f2fade5632801060693a5205c4bf8391702fe90c7`:

```
release sql131 v1
function_acl public.financial_totp_upsert_enrollment(uuid, bytea, bytea, text): acl=checksops EXECUTE grantor=owner;owner EXECUTE grantor=owner
function_acl public.financial_totp_get_enrollment(uuid): acl=checksops EXECUTE grantor=owner;owner EXECUTE grantor=owner
function_acl public.financial_totp_mark_verified(uuid, bigint): acl=checksops EXECUTE grantor=owner;owner EXECUTE grantor=owner
function_acl public.financial_totp_status(uuid): acl=checksops EXECUTE grantor=owner;owner EXECUTE grantor=owner
```

The same in staging and production (owner names are not part of it). The bodies are not part of it:
the post-condition `acl_functions_otherwise_unchanged` requires everything but the ACL unchanged.

**Expected pre-states.** Each is derived from the spec by `aws/tests/release-sql131-executor.test.mjs`
and read back from a PostgreSQL 16 database with the proposed file loaded:

| environment | EXECUTE on each of the four | fingerprint under `sql131` | recorded in |
|---|---|---|---|
| production | `PUBLIC`, `checksops`, owner (each granted by the owner) | `99d9e8e925ca8c5b56e11409f145e2d75de2759c27d8fd1b476494ffc62e2eaa` | the production pin, from the read-only inspect of 2026-10-30 (SSM `be25e88a…`, above) |
| staging | `checksops`, owner | `a661533320d9b391cc9b5c5f2fade5632801060693a5205c4bf8391702fe90c7` (the intended state: `already_applied` true) | the staging read-live run 41107844336, as the staging acceptance (above) |

Both were derived before they were read, and each run read the derived value. Staging's was expected
from SQL 130's read-live (run 41081764481 for SQL 129, run 41087643551 for SQL 130), which read the fifth
function without `PUBLIC`; the proposed file revokes `PUBLIC` from all five in one transaction, so the
four were expected to lack it too, and read-live run 41107844336 confirmed it. Each pin records its
own environment's read; neither value is written into a pin before a run reads it. A pre-state other than
these is not by itself a stop, but its per-function report and ACL must be read and explained before it
is recorded. A `PUBLIC` entry whose grantor is not the owner is refused (`acl_functions_acl_replaceable`):
that is a stop.

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present` (the four functions, role `checksops`); `predecessors_applied` (`sql130`);
`acl_functions_present`; `acl_functions_owned_by_login`; `acl_functions_acl_replaceable` (every live
entry is `checksops EXECUTE` or `owner EXECUTE` granted by the owner, which the file keeps, or
`PUBLIC EXECUTE` granted by the owner, which it revokes; nothing with grant option, nothing from another
grantor, no other grantee).

Post-conditions: the intended fingerprint; `acl_functions_otherwise_unchanged` (body, language,
volatility, `SECURITY DEFINER`, `proconfig`, result type and owner of each function as before);
everything else in schema `public` (and the functions of `auth`) unchanged. The tools roll back
otherwise.

## How the executor treats a database already in the intended state

The read-live reports `already_applied` true, `apply_preconditions_met` false and
`precondition_failures` `[]`. An apply against it is refused before the file runs
(`UNRELATED_MUTATION`: "SQL 131 is already in place; refuse re-apply"), and a pin that recorded that
state as its pre-state could not even be bound: the executor refuses a manifest whose expected live
hash equals the intended one before connecting (`INVALID_MANIFEST`, "intended replacement hash must
differ from the expected live definition hash", `sql-executor-auth.mjs`). The file itself is a no-op
there. So where staging reads as intended, no staging apply is run: the read-live run is the staging
acceptance and the staging pin stays pending (`execute: false`, `expected_live_definition_sha256`
`null`), as SQL 119's did (`ops/production-sql-119-apply.md`). Both refusals are shown on PostgreSQL 16
by `aws/tests/release-sql131-executor.test.mjs`.

## Steps

1. Staging: the staging executor must carry SQL 131 first (executor package refresh through the
   guarded staging executor `deploy` mode, its own reviewed run). Then run the guarded staging SQL
   executor with `read-live` for `sql131-financial-totp-functions-no-public`. Expected:
   `already_applied` true, `live_definition_sha256` `a6615333…` (the intended state),
   `precondition_failures` `[]`, `predecessors.sql130` true: then no staging apply, and the read-live
   run is the staging acceptance. If it reports `already_applied` false with `live_definition_sha256`
   `99d9e8e9…` (production's expected pre-state), record `LIVE_DEFINITION_SHA256` in the staging pin
   (`expected_live_definition_sha256`, owner-approved `authorization`, `execute: true`) in a reviewed
   change, `apply`, then `read-live` again. Anything else (`prerequisites_missing` other than `[]`,
   `precondition_failures` other than `[]`, another hash) is a stop.
2. Production: run the read-only inspect on the runner
   (`node scripts/deployment-guard/production-sql-one-shot.mjs --migration sql131 … --phase inspect`);
   expected `already_applied` false, live `99d9e8e9…`, `precondition_failures` `[]`,
   `predecessors.sql130` true. Record `production_inspect` and copy `live_definition_sha256` into
   `expected_live_definition_sha256`; record the staging run in `staging_acceptance`; set an
   owner-approved `authorization` and `execute: true`, in one reviewed change.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs
   --migration sql131 --approval-scope sql131 … --phase apply` with the owner's words
   (authorization phrase `REVOKE_FINANCIAL_TOTP_PUBLIC_EXECUTE`).
4. Record the apply and retire the pin (`execute: false`).
