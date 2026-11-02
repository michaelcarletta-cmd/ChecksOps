# Production SQL 140 (the automatic funding settings write grants)

| key | file | what it does |
|---|---|---|
| `sql140` | `aws/workflows/sql/140_wallet_funding_settings_write_grants.sql` (sha256 `7961cf7c68d56555f7135eb290a29c2c4d71fc3accead6d77908306f600d24c3`) | Fail-closed preconditions (`sql140_table_missing`, `sql140_column_missing`, `sql140_role_missing`), then `GRANT INSERT (tenant_id, auto_funding_enabled, funding_bank_account_id, funding_payment_method_id, funding_strategy, target_wallet_balance_cents, maximum_single_pull_cents, maximum_daily_pull_cents, require_payment_approval, authorization_accepted_at, authorization_accepted_by, authorization_version) ON TABLE public.tenant_wallet_funding_settings TO checksops` and `GRANT UPDATE (the same but tenant_id, plus updated_at) ON TABLE public.tenant_wallet_funding_settings TO checksops`. No other statement: no table-wide grant, no other column, no DELETE, SELECT, sequence or function grant, nothing to `authenticated`, PUBLIC or anon, no RLS or policy change. |

**Why.** Staging "Automatic funding" (the WalletOps auto-funding panel) cannot save the target wallet
balance. The staging API log (`/aws/lambda/checksops-staging-api`, 2026-11-02 12:31:40Z) shows
`POST /staging/functions/v1/save-tenant-wallet-funding-settings` answered 403 with the PostgreSQL
error `permission denied for table tenant_wallet_funding_settings`. That route is
`saveTenantWalletFundingSettings` (`aws/functions/api/tenant-settings-handlers.mjs`, #1524, live in
staging by overlay run 41440309944), which runs, as `checksops`, after `request.money_write` is set:

```
INSERT INTO public.tenant_wallet_funding_settings (tenant_id, <request columns>
  [, authorization_accepted_at, authorization_accepted_by])
VALUES (...)
ON CONFLICT (tenant_id) DO UPDATE SET <request columns>
  [, authorization_accepted_at = now(), authorization_accepted_by = $n::uuid], updated_at = now()
RETURNING *
```

The request columns are any of `auto_funding_enabled`, `funding_bank_account_id`,
`funding_payment_method_id`, `funding_strategy`, `target_wallet_balance_cents`,
`maximum_single_pull_cents`, `maximum_daily_pull_cents`, `require_payment_approval` and
`authorization_version`; `id`, `created_at` and `updated_at` take their defaults on INSERT.

The restored AWS databases gave `checksops` SELECT only on every table
(`aws/db-copy/sql/02_grant_readonly_application_role.sql`); each table's writes were granted by a
later numbered migration (SQL 50, 105, 112, 121, 134, 135) and none covers
`tenant_wallet_funding_settings` (the Supabase grants of `supabase/migrations/20260828201816_*.sql`
never reached the AWS copy). PostgreSQL checks table and column privileges before row-level
security, so the save is refused (42501) before any policy is evaluated. `ON CONFLICT` and
`RETURNING *` read with the table SELECT `checksops` already holds; SQL 140 does not grant SELECT.

Production's grants on this table are not recorded in this repository: the read-only inspect reads
them. A table-level write `checksops` may hold there from the restore (as `check_intake_items` had at
the SQL 89 inspect) is outside the fingerprint and is not changed; SQL 140 makes the thirteen
columns' ACL the same in both environments.

**Roles.** `checksops` only receives the grants: the API connects as `checksops`. Nothing to
`authenticated` (whose only member is `checksops`), PUBLIC, anon or `service_role`. The policies
below are `TO authenticated` and apply to `checksops` as a member.

**Policies (not changed).** `aws_write_tenant_wallet_funding_settings`
(`aws/rls/sql/24_complete_write_policies.sql`: `FOR ALL TO authenticated`, `USING` / `WITH CHECK`
`aws_can_write_tenant(tenant_id)`), `aws_select_tenant_wallet_funding_settings`
(`aws/rls/sql/12_final_select_policies.sql`, for `ON CONFLICT` and `RETURNING *`) and SQL 136's
three RESTRICTIVE `aws_money_write_gate_insert|update|delete_tenant_wallet_funding_settings`
policies (`aws_money_write_allowed()`, true while the route's `request.money_write = '1'` is set)
stay the authorization boundary. A member of another tenant, or a save without the flag where SQL
136 is applied, is refused by row-level security after SQL 140, as before.

**Expected outcomes of the inspect.** `already_applied` false with `precondition_failures` `[]`, or
`already_applied` true (every pinned line held: nothing to apply; the inspect is recorded as the
verified-live evidence and the pin stays `execute: false`). Anything else (a precondition failure,
such as another role's grant on one of the columns, a missing table, column or role) stops and needs
its own reviewed change.

**Status:** guarded tooling built; not applied anywhere. The staging pin is pending (no read-live yet); the production pin is pending.

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec
`column_acl` in `release-sql-specs.mjs`, as SQL 92, SQL 114, SQL 134 and SQL 135): the column ACL
(`pg_attribute.attacl`, every grantee) of the thirteen columns, or `absent` per column. Intended
`6157ad0d9a04d119c2f4c6b289470c302f16626de6b5d3e32ff25a93f161ea5b`:

```
release sql140 v1
column public.tenant_wallet_funding_settings.tenant_id acl: checksops INSERT
column public.tenant_wallet_funding_settings.auto_funding_enabled acl: checksops INSERT;checksops UPDATE
column public.tenant_wallet_funding_settings.funding_bank_account_id acl: checksops INSERT;checksops UPDATE
column public.tenant_wallet_funding_settings.funding_payment_method_id acl: checksops INSERT;checksops UPDATE
column public.tenant_wallet_funding_settings.funding_strategy acl: checksops INSERT;checksops UPDATE
column public.tenant_wallet_funding_settings.target_wallet_balance_cents acl: checksops INSERT;checksops UPDATE
column public.tenant_wallet_funding_settings.maximum_single_pull_cents acl: checksops INSERT;checksops UPDATE
column public.tenant_wallet_funding_settings.maximum_daily_pull_cents acl: checksops INSERT;checksops UPDATE
column public.tenant_wallet_funding_settings.require_payment_approval acl: checksops INSERT;checksops UPDATE
column public.tenant_wallet_funding_settings.authorization_accepted_at acl: checksops INSERT;checksops UPDATE
column public.tenant_wallet_funding_settings.authorization_accepted_by acl: checksops INSERT;checksops UPDATE
column public.tenant_wallet_funding_settings.authorization_version acl: checksops INSERT;checksops UPDATE
column public.tenant_wallet_funding_settings.updated_at acl: checksops UPDATE
```

**Expected pre-state (both environments; not recorded anywhere yet, each pin records its own
environment's read).** No column grant on any of the thirteen columns (the restore gave
`checksops` table SELECT only), derived by `aws/tests/release-sql140-executor.test.mjs` and read
back from a PostgreSQL 16 database with the table as the restore leaves it:
`fa08a3db73806391d757885c9165d0f1bf56a4571a22b1a32e2e63c73578952d`. The value is not written into a
pin before a run reads it. Table-level grants (`relacl`) and every other column's grants are
outside the fingerprint; the unrelated-catalog snapshot requires them, the table's RLS flag and its
policies unchanged.

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present` (the table, the thirteen columns, the role `checksops`);
`altered_relations_owned_by_login` (the login owns the table, so its GRANTs take effect);
`column_acl_replaceable` (every live grant on the thirteen columns is a pinned line: another role's
grant there would survive the file and is refused). No predecessor. A column that already holds its
lines passes: the file only adds the missing ones; all held is `already_applied` true.

Post-conditions: the intended fingerprint; everything else in schema `public` (and the functions
of `auth`) unchanged, the thirteen columns' ACLs excepted. The tools roll back otherwise.

## Order

No predecessor and no order. The API already sends the statement (#1524, live in staging by
overlay runs 41440309944 and 41440808804 and the staging SPA upload 41443239966); once SQL 140 is
applied in an environment the save passes the grant layer there and row-level security decides.
No Lambda or SPA change goes with it. No later migration revokes these grants. After the staging
apply, save the target wallet balance on staging WalletOps and read the staging API log.

## Steps

1. Staging: the staging executor must carry SQL 140 first (executor package refresh through the
   guarded staging executor `inspect` then `deploy` mode, its own reviewed run). Then run the
   guarded staging SQL executor with `read-live` for `sql140-wallet-funding-settings-write-grants`.
   Expected: `already_applied` false, `precondition_failures` `[]`, `live_definition_sha256`
   `fa08a3db…` (above). Read its `release_sql_inspect.columns` either way. If it reports
   `already_applied` true, record the run as the staging evidence (nothing to apply). If it reports
   `prerequisites_missing` other than `[]`, `precondition_failures` other than `[]` or another
   pre-state, stop. Otherwise record `LIVE_DEFINITION_SHA256` in the staging pin
   (`expected_live_definition_sha256`, owner-approved `authorization`, `execute: true`) in a
   reviewed change, `apply` with the owner's approval of that run, then `read-live` again
   (expected `already_applied` true), and have the owner save the automatic funding settings on
   staging.
2. Production: run the read-only inspect on the runner
   (`node scripts/deployment-guard/production-sql-one-shot.mjs --migration sql140 … --phase inspect`,
   or the tool's `--inspect`); record `production_inspect`. If `already_applied` is true, the
   reviewed change records it as verified live and leaves `execute: false`. Otherwise copy
   `live_definition_sha256` into `expected_live_definition_sha256`, record the staging runs in
   `staging_acceptance`, and set an owner-approved `authorization` and `execute: true`, in one
   reviewed change.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs
   --migration sql140 --approval-scope sql140 … --phase inspect`, then the owner-named
   `--phase apply` with the owner's words (authorization phrase
   `APPLY_WALLET_FUNDING_SETTINGS_WRITE_GRANTS`).
4. Record the apply and retire the pin (`execute: false`).
