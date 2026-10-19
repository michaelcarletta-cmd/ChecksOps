# Production SQL 103 (the Mortgage Ops auto-share trigger function ACL), before SQL 29

| key | file | what it does |
|---|---|---|
| `sql103` | `aws/workflows/sql/103_share_library_trigger_acl.sql` (sha256 `e018a9e7c8d0b00220bec8a5ebb5606232ff26d56c3012e3f1d64d5a25f0d43b`) | `REVOKE ALL ON FUNCTION public.share_library_docs_to_mortgage_request() FROM PUBLIC, checksops, authenticated`, after checking that the function and both roles exist (55000 `sql103_prerequisite_missing`) and that the login owns the function (42501 `sql103_not_function_owner`). Nothing else. |

**Why.** The read-only production inspect of SQL 29 (2026-10-19, main `bf6b7555e`) found the
trigger function's EXECUTE ACL `PUBLIC`, `checksops` and the owner (the owner is the
`checksops_admin` login). SQL 29 (`aws/rls/sql/29_mortgage_ops_library_parity.sql`) replaces the
function and revokes `PUBLIC` only, so its guard (`SQL29_TRIGGER_ACL_LINES` in
`scripts/deployment-guard/lib/sql-executor-auth.mjs`: owner and `PUBLIC` only) refuses with
`function_acl_replaceable`. SQL 29's file cannot change (its sha256 is in the append-only
release ledger), so SQL 103 removes the extra grant first. SQL 29 is then unchanged and reaches
its intended fingerprint `1271ea9b61ec983f88e911b23c569403979fb5f560880021b58d3b1e57243c79`.

**PUBLIC too.** SQL 29 removes `PUBLIC` itself, but SQL 103 revokes it as well: the state SQL 103
leaves is then one fingerprint (owner only) from any accepted starting ACL (production's, the
default `PUBLIC` + owner, or owner only after SQL 29), so its tools can verify the post-state
exactly, and the end state is SQL 29's intended one either way. A trigger function needs no
EXECUTE grant to fire.

**Status:** applied to production on 2026-10-19 (guarded one-shot, SSM
`805556fa-9e70-45d3-b20b-5e68ce64db7d`, main `dbaa93c90`, one_use_id
`sql103-prod-25bd6177-69b4-445c-bc10-686248723e0b`): `bade6813…` -> `4b909c59…`, post-apply
inspect `already_applied` true, owner-only EXECUTE, `precondition_failures` `[]` (Evidence
below). The production pin
(`ops/deployment-guard/sql103-share-library-trigger-acl-production-apply.json`) records the
apply in `applied` and is `execute: false` again, so a re-apply needs a new reviewed change.
It had been execute-authorized by the reviewed change of 2026-10-19 (owner-approved
`authorization`, `execute: true`, the recorded production pre-state and the staging read-live
acceptance below). The staging pin (`sql103-share-library-trigger-acl`) stays pending
(`execute: false`): staging is already in the intended state, so no staging apply is needed.

## Evidence (2026-10-19)

**Production read-only inspect** (`sql103-share-library-trigger-acl-production-apply.mjs
--inspect`, `BEGIN READ ONLY … ROLLBACK`, connected as `checksops_admin`):

| field | value |
|---|---|
| source | main `03e238afb0fab0be09b6c09f1bd3c812375c3717`, transfer tarball sha256 `1493cf711bb233c6fefc273d93aff0bf28b3c1b34ecf4e4247d161410f1ea4ff` |
| SSM command / runner | `1b740312-6e58-4412-9464-feac28e6bdf1` on `i-0c35557c4e5385406` |
| `live_definition_sha256` | `bade6813d689c91e3c8e39e33203e64eca23cc363f557062a7669407a01d5b9c` (pinned as `expected_live_definition_sha256`) |
| `intended_replacement_sha256` | `4b909c5929f0357ef442a1b2ebcb6bf8312e93be257010ed8a32072accf02aae` |
| `already_applied` | `false` |
| `precondition_failures` / `prerequisites_missing` / `successors_applied` | `[]` / `[]` / `[]` |

The same inspect run showed SQL 29 still refused only by `function_acl_replaceable` (live
`848277b1…`, intended `1271ea9b…`), which SQL 103 resolves.

**Staging acceptance** (`staging_acceptance.reference`
`https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/39188618156`): the guarded
staging SQL executor, deployed from main `03e238af` (deploy run `39188486411`, executor
package CodeSha256 `jJioB/XfKHPR0FgWuzGcah3QpYTa64h4Frue6QsQYQ8=`), `read-live` run
`39188618156` for `sql103-share-library-trigger-acl`: live == intended `4b909c59…`,
`already_applied` true, `precondition_failures` []. No staging apply was needed or run (step 1
below: the read-live run is the staging acceptance). The revoke path itself is covered on
PostgreSQL 16 by `aws/tests/sql103-share-library-trigger-acl-pg.test.mjs`. Staging's SQL 29
state is present but superseded by SQL 90 (staging SQL 29 read-live run `39188780526`: live
`711fb084…`, not SQL 29's intended `1271ea9b…`; `sql90_applied` true), so staging's owner-only
ACL is not evidence that SQL 29 is `already_applied` there.

**Production apply** (`production-sql-one-shot.mjs --migration sql103 --approval-scope sql103
--phase apply`, approval statement "apply SQL 103 in production", operator
`michaelcarletta-cmd`):

| field | value |
|---|---|
| source | main `dbaa93c90e1dd4c60b276d1eee2690652352fc97`, transfer tarball sha256 `94d7499a9fd3eadb867bd3e89412872e0c6cb8e8cacb3a3fe116f327059ed8e3` |
| SSM command / runner | `805556fa-9e70-45d3-b20b-5e68ce64db7d` on `i-0c35557c4e5385406` |
| one-shot run_id / workstream | `f8625a3b-0ade-48f2-a234-5581e8498327` / `prod-sql103-share-library-trigger-acl-20261019` |
| one_use_id | `sql103-prod-25bd6177-69b4-445c-bc10-686248723e0b` (spent) |
| contracts | claim-ledger 4/4, tenant-isolation 6/6, financial-write-protections 43/43 |
| manifest_sha256 | `825d924796c69e0d297a822ad91f5e1c272c9f8ae5a5b4e5a1e28cabd0759abf` |
| receipt | `bade6813…` -> `4b909c5929f0357ef442a1b2ebcb6bf8312e93be257010ed8a32072accf02aae`, result applied; unrelated catalog `373d503c6073d3d2c902d6f41c205ecfb47d32fca73de6b3ca9ae46674d8f1ca` (relations 861, functions 1281, policies 368, triggers 173, …) |
| post-apply inspect | `already_applied` true, ACL `owner EXECUTE grantor=owner` only, `precondition_failures` [] |

**Later read-only inspect** (SSM `45639f6b-68cf-4502-a127-458d99865ae8`, same main and
tarball; the same run inspected SQL 29, `ops/production-sql-29-30-apply.md`): SQL 103 live ==
intended `4b909c59…`, `already_applied` true.

## Run order (production)

1. **SQL 103** (this runbook).
2. **SQL 29** (`ops/production-sql-29-30-apply.md`), immediately after: its guard passes only
   once SQL 103 left the owner as the only grantee. Nothing in the repository grants the
   function to `checksops` or `authenticated` again, so nothing may run between them that does.
3. **SQL 30**.
4. **SQL 90** … **SQL 102** in release order (`ops/production-sql-90-97-apply.md`); SQL 29 and
   SQL 30 must be in before SQL 90 (SQL 29 refuses once SQL 90 is in place).

So: SQL 103 → SQL 29 → SQL 30 → SQL 90 → … → SQL 102. SQL 103 itself has no predecessor and
does not read SQL 29's state: it is safe before or after SQL 29 or SQL 90, and a no-op once the
owner is the only grantee (the tools then refuse it as already in place). The order is recorded
in the pin (`order_note`), the spec (`runs_before: ["sql29"]`) and the one-shot registry
(`ONE_SHOT_TOOLS.sql103.runs_before`); it is enforced by SQL 29's own guard, not by SQL 103.
`production-api-overlay-plan.json` has no entry for SQL 103: like SQL 29 and SQL 30 it holds
no Lambda member (`sql_before`).

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec
`acl_functions` in `release-sql-specs.mjs`, `render.grantors`): the function's EXECUTE ACL with
each entry's grantor (the owner read as `owner`), or `absent`. Intended
`4b909c5929f0357ef442a1b2ebcb6bf8312e93be257010ed8a32072accf02aae`:

```
release sql103 v1
function_acl public.share_library_docs_to_mortgage_request(): acl=owner EXECUTE grantor=owner
```

The same in staging and production (owner names are not part of it).

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present` (the function, roles `checksops` and `authenticated`);
`acl_functions_present`; `acl_functions_owned_by_login`; `acl_functions_acl_replaceable`
(every live entry is `owner EXECUTE` or a `PUBLIC` / `checksops` / `authenticated` EXECUTE
granted by the owner, without grant option: only those can the owner revoke).

Post-conditions: the intended fingerprint; `acl_functions_otherwise_unchanged` (body, language,
volatility, SECURITY DEFINER, `proconfig`, result type and owner as before); everything else in
schema `public` (and the functions of `auth`) unchanged. The tools roll back otherwise.

## Steps

1. Staging: the staging executor must carry SQL 103 and the engine change first (executor
   package refresh through `sql-executor-ensure.mjs` / the guarded staging executor `deploy`
   mode, its own reviewed run). Then run the guarded staging SQL executor with `read-live` for
   `sql103-share-library-trigger-acl`. Staging's function ACL is already owner-only (its SQL 29
   state is present but superseded by SQL 90: SQL 29 read-live run `39188780526`, live
   `711fb084…`, `sql90_applied` true), so SQL 103's read-live is expected to report
   `already_applied` true: no staging apply, and the read-live run is the staging acceptance. If it reports
   anything else, record `LIVE_DEFINITION_SHA256` in the staging pin
   (`expected_live_definition_sha256`, owner-approved `authorization`, `execute: true`) in a
   reviewed change, `apply`, then `read-live` again. Done 2026-10-19: read-live run
   `39188618156` reported `already_applied` true (Evidence above).
2. Production: run the read-only inspect on the runner
   (`node scripts/deployment-guard/sql103-share-library-trigger-acl-production-apply.mjs --inspect`);
   record `production_inspect` and copy `live_definition_sha256` into
   `expected_live_definition_sha256`; record the staging run in `staging_acceptance`; set an
   owner-approved `authorization` and `execute: true`, in one reviewed change, together with (or
   just before) SQL 29's pin change. Done 2026-10-19 (Evidence above); SQL 29's pin is a
   separate change and is still pending.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs
   --migration sql103 --approval-scope sql103 … --phase inspect`, then the owner-named
   `--phase apply`; then SQL 29's runs (`--migration sql29`), then SQL 30's. SQL 103 done
   2026-10-19 (SSM `805556fa-…`, Evidence above).
4. Record the apply and retire the pin (`execute: false`). Done: the pin records the
   2026-10-19 apply in `applied` and is `execute: false`.
