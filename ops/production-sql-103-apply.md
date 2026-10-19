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

**Status:** not applied anywhere. The staging pin (`sql103-share-library-trigger-acl`) and the
production pin (`ops/deployment-guard/sql103-share-library-trigger-acl-production-apply.json`)
are pending (`execute: false`, `authorization: "pending"`, no recorded pre-state, no staging
acceptance), so every apply refuses before connecting.

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
   `sql103-share-library-trigger-acl`. Staging already has SQL 29 (read-live
   `already_applied` true), so SQL 103's read-live is expected to report `already_applied`
   true: no staging apply, and the read-live run is the staging acceptance. If it reports
   anything else, record `LIVE_DEFINITION_SHA256` in the staging pin
   (`expected_live_definition_sha256`, owner-approved `authorization`, `execute: true`) in a
   reviewed change, `apply`, then `read-live` again.
2. Production: run the read-only inspect on the runner
   (`node scripts/deployment-guard/sql103-share-library-trigger-acl-production-apply.mjs --inspect`);
   record `production_inspect` and copy `live_definition_sha256` into
   `expected_live_definition_sha256`; record the staging run in `staging_acceptance`; set an
   owner-approved `authorization` and `execute: true`, in one reviewed change, together with (or
   just before) SQL 29's pin change.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs
   --migration sql103 --approval-scope sql103 … --phase inspect`, then the owner-named
   `--phase apply`; then SQL 29's runs (`--migration sql29`), then SQL 30's.
4. Record the apply and retire the pin (`execute: false`).
