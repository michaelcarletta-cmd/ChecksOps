# Production SQL 115 (one partner payout per tenant in the provider stakeholder sync)

| key | file | what it does |
|---|---|---|
| `sql115` | `aws/workflows/sql/115_provider_stakeholder_one_partner_payout.sql` (sha256 `5902638017eec4581a5f9241e93d9343b56ed39374beb671df8e8784e22f11ab`) | Replaces `public.sync_provider_stakeholder_account(uuid)` with the same signature, language, result, volatility, `SECURITY DEFINER` and `search_path = public`. When the tenant's latest receiving payment account has no `provider_connected` stakeholder for its provider and environment and the tenant already holds an active partner payout, it inserts nothing and returns that payout's id; an existing row for the account's environment is re-activated only when no other active partner payout exists. `REVOKE ALL` on the function from `PUBLIC`, and from `anon`, `authenticated` and `service_role` where they exist; no grant. Nothing else: no trigger, index, policy, table, column or row change. |

**Why.** `sync_provider_stakeholder_account(uuid)` (restored from supabase migration
`20260728110453`) runs after every INSERT or UPDATE of `payment_provider_accounts` and
`payment_provider_methods` (`trg_sync_provider_stakeholder_acct`,
`trg_sync_provider_stakeholder_bank`, through the `SECURITY DEFINER`
`trg_sync_provider_stakeholder_account()`). It keeps one `provider_connected` partner payout
stakeholder per tenant for the tenant's most recently updated receiving account, inserting one
when none exists for that account's provider and environment. It assumed one payment account per
tenant. `payment_provider_accounts` is unique on (tenant, provider, environment), so a tenant may
hold a Moov account per environment: on staging on 2026-10-25 Freedom Adjustment (tenant
`2eff5f1a`, a production-labelled account with an active partner payout) set up its sandbox test
account, and the first receiving update of the sandbox row inserted a second active partner
payout. `stakeholder_accounts_one_partner_payout` (one active partner payout per tenant) refused
it with 23505 and the trigger rolled back the statement, so `moov-sync` (Settings > Compliance &
Docs > Refresh) could never record the sandbox account's status (staging API log, route
`/functions/v1/moov-sync`). Production tenants hold one payment account each, so their behaviour
is unchanged; applying to production keeps the function the same in both environments.

**Expected outcomes of the inspect.** `already_applied` false with `precondition_failures` `[]`
(the restored supabase body), or `already_applied` true (nothing to apply; the inspect is
recorded as the verified-live evidence and the pin stays `execute: false`). Anything else (a
function not owned by the login, an EXECUTE grant outside the five lines below, a missing table,
column or function) stops and needs its own reviewed change.

**Staging executor refreshed (2026-10-25).** Inspect run 40240067999 (main `f5cc9ec`) found the
live executor at CodeSha256 `r6G9KanI…` without SQL 115 (adds
`sql/115_provider_stakeholder_one_partner_payout.sql`). Deploy run 40240193453 updated it to
main's package ("Verify live executor now carries main's package" passed).

**Staging read-live (2026-10-25).** Run 40240434651 (main `f5cc9ec`): the function `different`
(the restored supabase body), EXECUTE `PUBLIC` and the owner, `definer_writes`
`stakeholder_accounts` ok; live `6dbf58792a5eb0f9863ac0a6e88265de6ec9931a9e7a31bac21d7b71f643bba0`,
`already_applied` false, `precondition_failures` `[]`. Recorded in the staging pin
(`expected_live_definition_sha256`, `execute: true`, wave 16) under the owner's words of
2026-10-25, "Approve SQL 115 staging apply".

**Staging apply (2026-10-25).** Apply run 40243363235 (main `3d16422`, staging pin commit `3807a0c`):
result `applied`, before `6dbf58792a5eb0f9863ac0a6e88265de6ec9931a9e7a31bac21d7b71f643bba0`, after
`8aed39a49d988a60bdedac07a3a97f424a9de5c1499e4f50738f749326a62452` (intended), EXECUTE the owner's only.
Not recorded in the repository at the time; read from the run log on 2026-10-27. Read-live run
40501865500 (2026-10-27, main `24c7c54`): `already_applied` true.

**Production inspect (2026-10-27, after SQL 119).** Read-only `--inspect` through SSM
`6f6692d8-3801-4b70-b51c-dd9749e723b4` on `i-0c35557c4e5385406`, main `a01deea9b` (tarball sha256
`77e9e5d3f967ce8259518e6fcf1c64af8fb6c50c6b1fe8b44dce489bc0f70f07`, transfer run 40503922422, migration
source `5902638…` == pin), connected as `checksops_admin`, after SQL 119's production apply (one-shot run
`924b34f9-4fc6-446f-9190-e4bd9529cac8`): the function `different` (the restored supabase body), EXECUTE
the owner's only; live `ee9d2d5222dd9f8850173384b13468154fa03def6487824c3ef378db4874775b`,
`already_applied` false, `precondition_failures` `[]`. Before SQL 119 it was `83d480ac…` with
`[function_acl_replaceable]`.

**Pre-states.** Staging's (`6dbf5879…`) and production's (`ee9d2d52…`) differ only in the EXECUTE
ACL: the engine on PostgreSQL 16 gives, from the same restored supabase function, `6dbf5879…` with
`PUBLIC` and the owner, `83d480ac…` with `PUBLIC`, `checksops` and the owner, and `ee9d2d52…` with the
owner only (`aws/tests/sql119-provider-stakeholder-sync-acl-pg.test.mjs`). The staging apply is the
staging acceptance. Recorded in the production pin with `execute: true` under the owner's words of
2026-10-27, "Approve a pin PR for SQL 119, then one for SQL 115" and "Merge the SQL 115 pin PR when
green". Each apply still needs the owner's run-time approval.

**Production apply (2026-10-27).** After the pin change (#1290, merged on "Merge the SQL 115 pin PR
when green"), transfer run 40507251712 staged main `40678dc44` (tarball sha256
`00a482aee47dfaa5001e7f68b9bd57cfb17b6bcbfa1b7e983e933ef8720f27b4`). One-shot `--phase apply` run
`250cdbb8-0e46-42c8-a4a8-4a9a646ff07a` through SSM `bf96510f-4f95-42d5-974b-cf99d9a952ac` (Success),
workstream `prod-sql115-provider-stakeholder-one-partner-payout-20261027`, under the owner's words "AWS
reconnected, apply SQL 115 in production" (passed verbatim): every step ok, contracts 4/4, 6/6 and 43/43;
receipt `ee9d2d52…` → `8aed39a49d988a60bdedac07a3a97f424a9de5c1499e4f50738f749326a62452` (intended),
result `applied`, unrelated catalog `7bebf201…`; post-apply inspect `already_applied` true, EXECUTE the
owner's only. Production and staging now carry the same function.

**Status:** staging applied (wave 16); SQL 119 applied in production; applied to production (2026-10-27); the production pin is retired
(`execute: false`).

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec
`functions` in `release-sql-specs.mjs`): the function's language, volatility, parallel, security,
result, `proconfig`, `prosrc` sha256 and EXECUTE ACL. Intended
`8aed39a49d988a60bdedac07a3a97f424a9de5c1499e4f50738f749326a62452`:

```
release sql115 v1
function public.sync_provider_stakeholder_account(uuid): lang=plpgsql vol=v parallel=u secdef=true result=uuid config=search_path=public prosrc=71bf40f5940e3dcd1d65aa7879c8d4222cb25b4a56044161078eda2485ceb307 acl=owner EXECUTE
```

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present` (the function, `payment_provider_accounts`, `payment_provider_methods`,
`stakeholder_accounts`, `tenants`, `tenant_users` and the columns the function uses);
`functions_owned_by_login` (only the owner can replace it); `function_results_match` (returns
`uuid`); `function_acl_replaceable` (every live EXECUTE line is the owner's or one the file
revokes: `PUBLIC`, `anon`, `authenticated`, `service_role`); `definer_can_write_relations`
(`stakeholder_accounts`). No predecessor.

Post-conditions: the intended fingerprint; everything else in schema `public` (and the functions
of `auth`) unchanged, this function excepted. The tools roll back otherwise.

## Order

No predecessor and no order. No code change depends on it: the API keeps writing
`payment_provider_accounts` as before, and the trigger stops failing.

**Production: SQL 119 first.** The read-only production inspect of 2026-10-27 (SSM
`2db258df-47a8-414b-b7c6-b9686768c5b9`) found EXECUTE for `PUBLIC`, `checksops` and the owner,
live `83d480ac`, `precondition_failures` `[function_acl_replaceable]`: the `checksops` line is
not one this file revokes. SQL 119 (`ops/production-sql-119-apply.md`) runs immediately before
SQL 115 in production and leaves the owner as the only grantee; this file and its fingerprint
are unchanged. Staging needs no SQL 119 apply (SQL 115 is in and there is no `checksops`
grant); its read-live is SQL 119's staging acceptance.

## Steps

1. Staging: the staging executor must carry SQL 115 first (executor package refresh through
   `sql-executor-ensure.mjs` / the guarded staging executor `deploy` mode, its own reviewed run).
   Then run the guarded staging SQL executor with `read-live` for
   `sql115-provider-stakeholder-one-partner-payout`. If it reports `already_applied` false and
   `precondition_failures` `[]`, record `LIVE_DEFINITION_SHA256` in the staging pin
   (`expected_live_definition_sha256`, owner-approved `authorization`, `execute: true`) in a
   reviewed change, `apply` with the owner's approval of that run, then `read-live` again
   (expected `already_applied` true). Anything else: stop and record it in its own reviewed
   change.
2. Production: run the read-only inspect on the runner
   (`node scripts/deployment-guard/sql115-provider-stakeholder-one-partner-payout-production-apply.mjs --inspect`,
   or the one-shot's `--phase inspect`); record `production_inspect`. If `already_applied` is
   true, the reviewed change records it as verified live and leaves `execute: false`. Otherwise
   copy `live_definition_sha256` into `expected_live_definition_sha256`, record the staging runs
   in `staging_acceptance`, and set an owner-approved `authorization` and `execute: true`, in one
   reviewed change.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs
   --migration sql115 --approval-scope sql115 … --phase inspect`, then the owner-named
   `--phase apply`.
4. Record the apply and retire the pin (`execute: false`).
