# Production SQL 119 (the payment-account stakeholder sync function ACL), before SQL 115

| key | file | what it does |
|---|---|---|
| `sql119` | `aws/workflows/sql/119_provider_stakeholder_sync_acl.sql` (sha256 `aed7a418e5776f1eeb00f3eb67287bb3177ec4898c14105e44d1eeea5868a30b`) | `REVOKE ALL ON FUNCTION public.sync_provider_stakeholder_account(uuid) FROM PUBLIC, checksops`, and from `anon`, `authenticated` and `service_role` where those roles exist, after checking that the function and the role `checksops` exist (55000 `sql119_prerequisite_missing`) and that the login owns the function (42501 `sql119_not_function_owner`). Nothing else. |

**Why.** The read-only production inspect of SQL 115 (2026-10-27, SSM
`2db258df-47a8-414b-b7c6-b9686768c5b9`) found the function's EXECUTE ACL `PUBLIC`,
`checksops` and the owner (the owner is the `checksops_admin` login), live
`83d480ac`, `precondition_failures` `[function_acl_replaceable]`. SQL 115
(`aws/workflows/sql/115_provider_stakeholder_one_partner_payout.sql`) replaces the function and
revokes `PUBLIC`, `anon`, `authenticated` and `service_role` only, so its guard refuses the
`checksops` entry. SQL 115's file cannot change (append-only; its bytes are pinned), so SQL 119
removes the extra grant first, as SQL 103 does for SQL 29. SQL 115 is then unchanged and reaches
its intended fingerprint `8aed39a4`.

**Nobody loses access.** The function's callers are `SECURITY DEFINER` and run as the owner:
`trg_sync_provider_stakeholder_account()` (the trigger function of
`trg_sync_provider_stakeholder_acct` and `trg_sync_provider_stakeholder_bank`),
`autoadd_partner_stakeholder_on_share()` and `add_partner_stakeholder_to_check(uuid, uuid)`.
The API never calls it.

**PUBLIC too.** SQL 115 removes `PUBLIC` itself, but SQL 119 revokes it as well: the state SQL 119
leaves is then one fingerprint (owner only) from any accepted starting ACL (production's, the
default `PUBLIC` + owner, or owner only after SQL 115), so its tools can verify the post-state
exactly, and the end state is SQL 115's intended one either way.

**Staging executor (2026-10-27).** Inspect run 40501251073 (main `24c7c54`) found the live
executor at `Am+LSNC5…` without SQL 119 (adds `sql/119_provider_stakeholder_sync_acl.sql`). Deploy
run 40501540682 updated it to `Ffm7CRLPMz9OjoPT/mOeArKcoig4/C/F3OoSYvqF398=` ("Verify live executor
now carries main's package" passed).

**Staging read-live (2026-10-27).** Run 40501861802 (main `24c7c54`): the function `intended`,
EXECUTE the owner's only; live `3d62a511f479415b3a30ec532583527dc0f457ef3e6a2810bdccfab707dc0888`
(intended), `already_applied` true, `precondition_failures` `[]`. Staging has SQL 115 applied
(read-live run 40501865500: `already_applied` true, live `8aed39a4…`), so no staging apply is needed;
this read-live is the staging acceptance and the staging pin stays pending.

**Production inspect (2026-10-27).** Read-only `--inspect` through SSM
`0019857c-86f0-46da-94e4-1805e6cd6cd7` on `i-0c35557c4e5385406`, main `24c7c545e` (tarball sha256
`87d41441e36b92bd669e11c36078c9fd830f283b0ca7d284cec65a8fd8670dad`, transfer run 40501270069, migration
source `aed7a418…` == pin), connected as `checksops_admin`: EXECUTE for `PUBLIC`, `checksops` and the
owner, each granted by the owner; live
`249237decc1f079bf04915a5f42862792efb13f00729a8d0bbbfdb8b5c456e35`, `already_applied` false,
`precondition_failures` `[]`. The same command's SQL 115 inspect still reports
`[function_acl_replaceable]` (live `83d480ac…`). Recorded in the production pin with the staging
read-live as its staging acceptance and `execute: true` under the owner's words of 2026-10-27,
"Approve a pin PR for SQL 119, then one for SQL 115". Each apply still needs the owner's run-time
approval.

**Status:** staging already in the intended state (no apply); production pin execute-authorized;
production apply pending. SQL 115's production pre-state changes with SQL 119 (its fingerprint
includes the ACL), so SQL 115's pin records a production inspect taken after SQL 119's apply.

## Run order (production)

1. **SQL 119** (this runbook).
2. **SQL 115** (`ops/production-sql-115-apply.md`), immediately after: its guard passes only once
   SQL 119 left the owner as the only grantee. Nothing in the repository grants the function to
   `checksops` again, so nothing may run between them that does.

SQL 119 itself has no predecessor and does not read SQL 115's state: it is a no-op once the
owner is the only grantee (the tools then refuse it as already in place). The order is recorded
in the pin (`order_note`), the spec (`runs_before: ["sql115"]`) and the one-shot registry
(`ONE_SHOT_TOOLS.sql119.runs_before`); it is enforced by SQL 115's own guard, not by SQL 119.
`production-api-overlay-plan.json` has no entry for SQL 119: it holds no Lambda member.

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec
`acl_functions` in `release-sql-specs.mjs`, `render.grantors`): the function's EXECUTE ACL with
each entry's grantor (the owner read as `owner`), or `absent`. Intended
`3d62a511f479415b3a30ec532583527dc0f457ef3e6a2810bdccfab707dc0888`:

```
release sql119 v1
function_acl public.sync_provider_stakeholder_account(uuid): acl=owner EXECUTE grantor=owner
```

The same in staging and production (owner names are not part of it).

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present` (the function, role `checksops`); `acl_functions_present`;
`acl_functions_owned_by_login`; `acl_functions_acl_replaceable` (every live entry is
`owner EXECUTE` or a `PUBLIC` / `anon` / `authenticated` / `checksops` / `service_role` EXECUTE
granted by the owner, without grant option: only those can the owner revoke).

Post-conditions: the intended fingerprint; `acl_functions_otherwise_unchanged` (body, language,
volatility, SECURITY DEFINER, `proconfig`, result type and owner as before); everything else in
schema `public` (and the functions of `auth`) unchanged. The tools roll back otherwise.

## Steps

1. Staging: the staging executor must carry SQL 119 first (executor package refresh through the
   guarded staging executor `deploy` mode, its own reviewed run). Then run the guarded staging
   SQL executor with `read-live` for `sql119-provider-stakeholder-sync-acl`. Staging already has
   SQL 115, so SQL 119's read-live is expected to report `already_applied` true: no staging
   apply, and the read-live run is the staging acceptance. If it reports anything else, record
   `LIVE_DEFINITION_SHA256` in the staging pin (`expected_live_definition_sha256`,
   owner-approved `authorization`, `execute: true`) in a reviewed change, `apply`, then
   `read-live` again.
2. Production: run the read-only inspect on the runner
   (`node scripts/deployment-guard/production-sql-one-shot.mjs --migration sql119 … --phase inspect`);
   record `production_inspect` and copy `live_definition_sha256` into
   `expected_live_definition_sha256`; record the staging run in `staging_acceptance`; set an
   owner-approved `authorization` and `execute: true`, in one reviewed change, together with (or
   just before) SQL 115's pin change.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs
   --migration sql119 --approval-scope sql119 … --phase apply` with the owner's words; then SQL
   115's runs (`--migration sql115`).
4. Record the apply and retire the pin (`execute: false`).
