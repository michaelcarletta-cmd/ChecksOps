# Production SQL 136 (the 24 money tables writable only on a server write path)

| key | file | what it does |
|---|---|---|
| `sql136` | `aws/workflows/sql/136_money_write_restrictive_policies.sql` (sha256 `b10a380812a2708886c04d7cc24b74a329b2d1f566105dcf9b1e9f8c595e82e2`) | Refuses when a money table or SQL 91's GUC helper is missing (`42P01 sql136_table_missing`, `42883 sql136_function_missing`, `42704 sql136_role_missing`), while a money table is `FORCE ROW LEVEL SECURITY` (`55000 sql136_force_rls`), a SECURITY DEFINER writer of a money table is owned by a role that does not bypass its RLS (`55000 sql136_definer_writer_cannot_bypass_rls`) or a SECURITY INVOKER trigger function writes a money table (`55000 sql136_invoker_trigger_writes_money_table`). Then `CREATE OR REPLACE FUNCTION public.aws_money_write_allowed()` (`sql`, `STABLE`, SECURITY INVOKER), its `COMMENT`, `REVOKE ALL ... FROM PUBLIC`, `GRANT EXECUTE ... TO checksops, authenticated`, and on each of the 24 money tables `DROP POLICY IF EXISTS` / `CREATE POLICY` of three RESTRICTIVE policies TO authenticated. No other statement. |

## STOP: the API first

**Do not run a staging read-live-to-apply, a production inspect-to-apply, or any apply of SQL 136 in an
environment before #1498's API is live there.** That is:

1. the eight production overlay members of the money-write flag
   (`aws/tests/fixtures/production-money-write-flag-manifest-2026-10-31.json`), each through its own guarded
   overlay run, in plan order: ADD `money-write-flag.mjs`, then REPLACE
   `providers/production/moov-wallet-sync.mjs`, `providers/parity/moov-functions.mjs`,
   `tenant-settings-handlers.mjs`, `tenant-collection-v2-settlement.mjs`, `tenant-collection-v2.mjs`,
   `tenant-billing-engine.mjs` and `tenant-billing-handlers.mjs` (staging through the staging overlay);
2. AND a full Lambda rebuild that carries `invoice-provider.mjs`, `mortgage-ops-usage.mjs` and
   `tenant-collection-v2-uat.mjs`, which are not overlay members.

Applied earlier, every API money write that does not yet set `request.money_write` is refused (invoices,
billing accrual, collection, wallet sync, settings). Neither the file nor its tools can see the Lambda:
the reviewed change that sets a pin's `execute: true` must name the overlay run ids and the rebuild run id
that put the API live in that environment, and the owner's staging acceptance must include the staging
money flows still writing.

**Why.** Security audit 2026-10-29, finding 14 (medium). SQL 90 made `public.aws_can_write_tenant()` plain
tenant membership, so SQL 24's `aws_write_<table>` policies (`FOR ALL TO authenticated USING / WITH CHECK
(public.aws_can_write_tenant(tenant_id))`, `aws/rls/sql/24_complete_write_policies.sql`) let any tenant
member's session INSERT, UPDATE or DELETE the money tables directly; the gated SQL 72 / SQL 91 policies are
permissive too, so they add nothing. Owner decision 2026-10-31 (a): the API first (#1498: every API money
write sets the transaction-local, server-only GUC `request.money_write = '1'` first;
`aws/functions/api/money-write-flag.mjs`, `aws/docs/money-write-flag.md`), then this file. Owner
2026-11-01: "Complete sql 138 and 136".

**What it changes.** One new function and 72 policies:

- `public.aws_money_write_allowed()`: `LANGUAGE sql`, `STABLE`, SECURITY INVOKER, `RETURNS boolean`; true
  only while the transaction set `request.money_write = '1'` (#1498's API writers),
  `request.financial_execution = '1'` (SQL 72's writers, production `moov-wallet-fund.mjs` and
  `moov-send.mjs`, which set it without the SQL 72 activation GUC; uncovered item 1 of #1498), or one of
  SQL 91's `aws_moov_onboarding_active()` / `aws_moov_webhook_apply_active()`. EXECUTE: `authenticated`,
  `checksops` and the owner (a policy expression runs as the querying role); `PUBLIC` revoked.
- On each of the 24 money tables (`ach_authorizations`, `actum_transactions`, `check_billing_events`,
  `claim_check_payments`, `disbursement_splits`, `external_payment_recipients`,
  `micro_deposit_verifications`, `moov_invoice_customers`, `moov_invoices`, `payment_method_verifications`,
  `payment_provider_methods`, `payment_sweep_configs`, `payment_transfer_groups`, `payment_transfers`,
  `payment_wallet_sub_ledgers`, `payment_wallets`, `payroll_runs`, `stakeholder_limit_requests`,
  `tenant_bank_accounts`, `tenant_billing_accounts`, `tenant_credit_balances`,
  `tenant_credit_transactions`, `tenant_maintenance_payments`, `tenant_wallet_funding_settings`):
  `aws_money_write_gate_insert_<table>` (`AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK`),
  `aws_money_write_gate_update_<table>` (`FOR UPDATE ... USING ... WITH CHECK`) and
  `aws_money_write_gate_delete_<table>` (`FOR DELETE ... USING`), each `public.aws_money_write_allowed()`.
  Never `FOR ALL`: a restrictive `FOR ALL` would also filter `SELECT`.

The permissive SQL 24 / SQL 72 / SQL 91 policies stay and still decide *which tenant's* rows a session may
write; the restrictive policies decide that only a server write path may write at all. `SELECT` is
unchanged. SECURITY DEFINER writers owned by the table owner (SQL 98 / SQL 120 billing triggers, SQL 109 /
SQL 62 transfer status writers, SQL 113 / SQL 138 payee functions) and FK referential actions are not
subject to RLS and keep working without the flag.

**Uncovered items of #1498, now preconditions.** (2) The live-only trigger function
`tg_accrue_mortgage_ops_billing` (trigger `tr_accrue_mortgage_ops_billing` on
`mortgage_handling_requests`, writes `check_billing_events`; no repository SQL): if it is SECURITY
INVOKER, `no_invoker_trigger_money_writers` and the file's `sql136_invoker_trigger_writes_money_table`
stop SQL 136. (3) Every SECURITY DEFINER writer must be owned by a role that bypasses the table's RLS and no
money table may be `FORCE ROW LEVEL SECURITY`: `money_definer_writers_bypass_rls` /
`money_tables_not_forced_rls` and the file's `sql136_definer_writer_cannot_bypass_rls` / `sql136_force_rls`.
The engine reads these as catalog counts (never rows) in a staging read-live and a production inspect, so
they show before any apply. `money_invoker_function_writers` (SECURITY INVOKER, non-trigger functions in
`public` whose body writes a money table) is reported, not a stop: such a function works only when its
caller set a flag first, so a non-zero count must be read and reviewed before the apply.

**Status:** not applied anywhere. The staging pin and the production pin are pending, and neither may move
before #1498's API is live in that environment.

## Fingerprint

Code-derived on the release engine (`scripts/deployment-guard/lib/release-sql-state.mjs`, spec `sql136` in
`release-sql-specs.mjs`). Intended `f8269d3e1f788d50ad0cbbb4b95829b3ee83b05cda91798c5f57491c8e5d26a7`:

```
release sql136 v1
function public.aws_money_write_allowed(): lang=sql vol=s parallel=u secdef=false result=boolean config= prosrc=a83a67f87baacf405b0e180c60a9b74564494d491dd7d241c51111010ed89023 acl=authenticated EXECUTE;checksops EXECUTE;owner EXECUTE
policy public.ach_authorizations aws_money_write_gate_insert_ach_authorizations: cmd=INSERT permissive=false roles=authenticated qual=- with_check=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a
policy public.ach_authorizations aws_money_write_gate_update_ach_authorizations: cmd=UPDATE permissive=false roles=authenticated qual=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a with_check=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a
policy public.ach_authorizations aws_money_write_gate_delete_ach_authorizations: cmd=DELETE permissive=false roles=authenticated qual=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a with_check=-
policy public.actum_transactions aws_money_write_gate_insert_actum_transactions: cmd=INSERT permissive=false roles=authenticated qual=- with_check=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a
policy public.actum_transactions aws_money_write_gate_update_actum_transactions: cmd=UPDATE permissive=false roles=authenticated qual=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a with_check=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a
policy public.actum_transactions aws_money_write_gate_delete_actum_transactions: cmd=DELETE permissive=false roles=authenticated qual=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a with_check=-
policy public.check_billing_events aws_money_write_gate_insert_check_billing_events: cmd=INSERT permissive=false roles=authenticated qual=- with_check=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a
policy public.check_billing_events aws_money_write_gate_update_check_billing_events: cmd=UPDATE permissive=false roles=authenticated qual=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a with_check=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a
policy public.check_billing_events aws_money_write_gate_delete_check_billing_events: cmd=DELETE permissive=false roles=authenticated qual=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a with_check=-
policy public.claim_check_payments aws_money_write_gate_insert_claim_check_payments: cmd=INSERT permissive=false roles=authenticated qual=- with_check=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a
policy public.claim_check_payments aws_money_write_gate_update_claim_check_payments: cmd=UPDATE permissive=false roles=authenticated qual=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a with_check=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a
policy public.claim_check_payments aws_money_write_gate_delete_claim_check_payments: cmd=DELETE permissive=false roles=authenticated qual=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a with_check=-
policy public.disbursement_splits aws_money_write_gate_insert_disbursement_splits: cmd=INSERT permissive=false roles=authenticated qual=- with_check=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a
policy public.disbursement_splits aws_money_write_gate_update_disbursement_splits: cmd=UPDATE permissive=false roles=authenticated qual=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a with_check=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a
policy public.disbursement_splits aws_money_write_gate_delete_disbursement_splits: cmd=DELETE permissive=false roles=authenticated qual=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a with_check=-
policy public.external_payment_recipients aws_money_write_gate_insert_external_payment_recipients: cmd=INSERT permissive=false roles=authenticated qual=- with_check=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a
policy public.external_payment_recipients aws_money_write_gate_update_external_payment_recipients: cmd=UPDATE permissive=false roles=authenticated qual=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a with_check=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a
policy public.external_payment_recipients aws_money_write_gate_delete_external_payment_recipients: cmd=DELETE permissive=false roles=authenticated qual=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a with_check=-
policy public.micro_deposit_verifications aws_money_write_gate_insert_micro_deposit_verifications: cmd=INSERT permissive=false roles=authenticated qual=- with_check=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a
policy public.micro_deposit_verifications aws_money_write_gate_update_micro_deposit_verifications: cmd=UPDATE permissive=false roles=authenticated qual=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a with_check=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a
policy public.micro_deposit_verifications aws_money_write_gate_delete_micro_deposit_verifications: cmd=DELETE permissive=false roles=authenticated qual=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a with_check=-
policy public.moov_invoice_customers aws_money_write_gate_insert_moov_invoice_customers: cmd=INSERT permissive=false roles=authenticated qual=- with_check=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a
policy public.moov_invoice_customers aws_money_write_gate_update_moov_invoice_customers: cmd=UPDATE permissive=false roles=authenticated qual=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a with_check=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a
policy public.moov_invoice_customers aws_money_write_gate_delete_moov_invoice_customers: cmd=DELETE permissive=false roles=authenticated qual=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a with_check=-
policy public.moov_invoices aws_money_write_gate_insert_moov_invoices: cmd=INSERT permissive=false roles=authenticated qual=- with_check=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a
policy public.moov_invoices aws_money_write_gate_update_moov_invoices: cmd=UPDATE permissive=false roles=authenticated qual=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a with_check=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a
policy public.moov_invoices aws_money_write_gate_delete_moov_invoices: cmd=DELETE permissive=false roles=authenticated qual=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a with_check=-
policy public.payment_method_verifications aws_money_write_gate_insert_payment_method_verifications: cmd=INSERT permissive=false roles=authenticated qual=- with_check=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a
policy public.payment_method_verifications aws_money_write_gate_update_payment_method_verifications: cmd=UPDATE permissive=false roles=authenticated qual=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a with_check=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a
policy public.payment_method_verifications aws_money_write_gate_delete_payment_method_verifications: cmd=DELETE permissive=false roles=authenticated qual=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a with_check=-
policy public.payment_provider_methods aws_money_write_gate_insert_payment_provider_methods: cmd=INSERT permissive=false roles=authenticated qual=- with_check=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a
policy public.payment_provider_methods aws_money_write_gate_update_payment_provider_methods: cmd=UPDATE permissive=false roles=authenticated qual=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a with_check=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a
policy public.payment_provider_methods aws_money_write_gate_delete_payment_provider_methods: cmd=DELETE permissive=false roles=authenticated qual=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a with_check=-
policy public.payment_sweep_configs aws_money_write_gate_insert_payment_sweep_configs: cmd=INSERT permissive=false roles=authenticated qual=- with_check=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a
policy public.payment_sweep_configs aws_money_write_gate_update_payment_sweep_configs: cmd=UPDATE permissive=false roles=authenticated qual=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a with_check=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a
policy public.payment_sweep_configs aws_money_write_gate_delete_payment_sweep_configs: cmd=DELETE permissive=false roles=authenticated qual=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a with_check=-
policy public.payment_transfer_groups aws_money_write_gate_insert_payment_transfer_groups: cmd=INSERT permissive=false roles=authenticated qual=- with_check=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a
policy public.payment_transfer_groups aws_money_write_gate_update_payment_transfer_groups: cmd=UPDATE permissive=false roles=authenticated qual=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a with_check=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a
policy public.payment_transfer_groups aws_money_write_gate_delete_payment_transfer_groups: cmd=DELETE permissive=false roles=authenticated qual=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a with_check=-
policy public.payment_transfers aws_money_write_gate_insert_payment_transfers: cmd=INSERT permissive=false roles=authenticated qual=- with_check=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a
policy public.payment_transfers aws_money_write_gate_update_payment_transfers: cmd=UPDATE permissive=false roles=authenticated qual=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a with_check=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a
policy public.payment_transfers aws_money_write_gate_delete_payment_transfers: cmd=DELETE permissive=false roles=authenticated qual=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a with_check=-
policy public.payment_wallet_sub_ledgers aws_money_write_gate_insert_payment_wallet_sub_ledgers: cmd=INSERT permissive=false roles=authenticated qual=- with_check=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a
policy public.payment_wallet_sub_ledgers aws_money_write_gate_update_payment_wallet_sub_ledgers: cmd=UPDATE permissive=false roles=authenticated qual=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a with_check=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a
policy public.payment_wallet_sub_ledgers aws_money_write_gate_delete_payment_wallet_sub_ledgers: cmd=DELETE permissive=false roles=authenticated qual=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a with_check=-
policy public.payment_wallets aws_money_write_gate_insert_payment_wallets: cmd=INSERT permissive=false roles=authenticated qual=- with_check=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a
policy public.payment_wallets aws_money_write_gate_update_payment_wallets: cmd=UPDATE permissive=false roles=authenticated qual=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a with_check=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a
policy public.payment_wallets aws_money_write_gate_delete_payment_wallets: cmd=DELETE permissive=false roles=authenticated qual=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a with_check=-
policy public.payroll_runs aws_money_write_gate_insert_payroll_runs: cmd=INSERT permissive=false roles=authenticated qual=- with_check=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a
policy public.payroll_runs aws_money_write_gate_update_payroll_runs: cmd=UPDATE permissive=false roles=authenticated qual=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a with_check=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a
policy public.payroll_runs aws_money_write_gate_delete_payroll_runs: cmd=DELETE permissive=false roles=authenticated qual=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a with_check=-
policy public.stakeholder_limit_requests aws_money_write_gate_insert_stakeholder_limit_requests: cmd=INSERT permissive=false roles=authenticated qual=- with_check=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a
policy public.stakeholder_limit_requests aws_money_write_gate_update_stakeholder_limit_requests: cmd=UPDATE permissive=false roles=authenticated qual=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a with_check=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a
policy public.stakeholder_limit_requests aws_money_write_gate_delete_stakeholder_limit_requests: cmd=DELETE permissive=false roles=authenticated qual=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a with_check=-
policy public.tenant_bank_accounts aws_money_write_gate_insert_tenant_bank_accounts: cmd=INSERT permissive=false roles=authenticated qual=- with_check=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a
policy public.tenant_bank_accounts aws_money_write_gate_update_tenant_bank_accounts: cmd=UPDATE permissive=false roles=authenticated qual=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a with_check=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a
policy public.tenant_bank_accounts aws_money_write_gate_delete_tenant_bank_accounts: cmd=DELETE permissive=false roles=authenticated qual=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a with_check=-
policy public.tenant_billing_accounts aws_money_write_gate_insert_tenant_billing_accounts: cmd=INSERT permissive=false roles=authenticated qual=- with_check=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a
policy public.tenant_billing_accounts aws_money_write_gate_update_tenant_billing_accounts: cmd=UPDATE permissive=false roles=authenticated qual=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a with_check=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a
policy public.tenant_billing_accounts aws_money_write_gate_delete_tenant_billing_accounts: cmd=DELETE permissive=false roles=authenticated qual=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a with_check=-
policy public.tenant_credit_balances aws_money_write_gate_insert_tenant_credit_balances: cmd=INSERT permissive=false roles=authenticated qual=- with_check=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a
policy public.tenant_credit_balances aws_money_write_gate_update_tenant_credit_balances: cmd=UPDATE permissive=false roles=authenticated qual=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a with_check=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a
policy public.tenant_credit_balances aws_money_write_gate_delete_tenant_credit_balances: cmd=DELETE permissive=false roles=authenticated qual=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a with_check=-
policy public.tenant_credit_transactions aws_money_write_gate_insert_tenant_credit_transactions: cmd=INSERT permissive=false roles=authenticated qual=- with_check=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a
policy public.tenant_credit_transactions aws_money_write_gate_update_tenant_credit_transactions: cmd=UPDATE permissive=false roles=authenticated qual=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a with_check=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a
policy public.tenant_credit_transactions aws_money_write_gate_delete_tenant_credit_transactions: cmd=DELETE permissive=false roles=authenticated qual=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a with_check=-
policy public.tenant_maintenance_payments aws_money_write_gate_insert_tenant_maintenance_payments: cmd=INSERT permissive=false roles=authenticated qual=- with_check=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a
policy public.tenant_maintenance_payments aws_money_write_gate_update_tenant_maintenance_payments: cmd=UPDATE permissive=false roles=authenticated qual=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a with_check=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a
policy public.tenant_maintenance_payments aws_money_write_gate_delete_tenant_maintenance_payments: cmd=DELETE permissive=false roles=authenticated qual=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a with_check=-
policy public.tenant_wallet_funding_settings aws_money_write_gate_insert_tenant_wallet_funding_settings: cmd=INSERT permissive=false roles=authenticated qual=- with_check=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a
policy public.tenant_wallet_funding_settings aws_money_write_gate_update_tenant_wallet_funding_settings: cmd=UPDATE permissive=false roles=authenticated qual=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a with_check=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a
policy public.tenant_wallet_funding_settings aws_money_write_gate_delete_tenant_wallet_funding_settings: cmd=DELETE permissive=false roles=authenticated qual=370b8421506c5df1c0b0734de040be073cfea254d8d85e4bd9d48bf4f16db72a with_check=-
```

**Expected pre-state (both environments).** Neither the function nor any of the 72 policies exists:

```
release sql136 v1
function public.aws_money_write_allowed(): absent
policy public.ach_authorizations aws_money_write_gate_insert_ach_authorizations: absent
policy public.ach_authorizations aws_money_write_gate_update_ach_authorizations: absent
policy public.ach_authorizations aws_money_write_gate_delete_ach_authorizations: absent
policy public.actum_transactions aws_money_write_gate_insert_actum_transactions: absent
policy public.actum_transactions aws_money_write_gate_update_actum_transactions: absent
policy public.actum_transactions aws_money_write_gate_delete_actum_transactions: absent
policy public.check_billing_events aws_money_write_gate_insert_check_billing_events: absent
policy public.check_billing_events aws_money_write_gate_update_check_billing_events: absent
policy public.check_billing_events aws_money_write_gate_delete_check_billing_events: absent
policy public.claim_check_payments aws_money_write_gate_insert_claim_check_payments: absent
policy public.claim_check_payments aws_money_write_gate_update_claim_check_payments: absent
policy public.claim_check_payments aws_money_write_gate_delete_claim_check_payments: absent
policy public.disbursement_splits aws_money_write_gate_insert_disbursement_splits: absent
policy public.disbursement_splits aws_money_write_gate_update_disbursement_splits: absent
policy public.disbursement_splits aws_money_write_gate_delete_disbursement_splits: absent
policy public.external_payment_recipients aws_money_write_gate_insert_external_payment_recipients: absent
policy public.external_payment_recipients aws_money_write_gate_update_external_payment_recipients: absent
policy public.external_payment_recipients aws_money_write_gate_delete_external_payment_recipients: absent
policy public.micro_deposit_verifications aws_money_write_gate_insert_micro_deposit_verifications: absent
policy public.micro_deposit_verifications aws_money_write_gate_update_micro_deposit_verifications: absent
policy public.micro_deposit_verifications aws_money_write_gate_delete_micro_deposit_verifications: absent
policy public.moov_invoice_customers aws_money_write_gate_insert_moov_invoice_customers: absent
policy public.moov_invoice_customers aws_money_write_gate_update_moov_invoice_customers: absent
policy public.moov_invoice_customers aws_money_write_gate_delete_moov_invoice_customers: absent
policy public.moov_invoices aws_money_write_gate_insert_moov_invoices: absent
policy public.moov_invoices aws_money_write_gate_update_moov_invoices: absent
policy public.moov_invoices aws_money_write_gate_delete_moov_invoices: absent
policy public.payment_method_verifications aws_money_write_gate_insert_payment_method_verifications: absent
policy public.payment_method_verifications aws_money_write_gate_update_payment_method_verifications: absent
policy public.payment_method_verifications aws_money_write_gate_delete_payment_method_verifications: absent
policy public.payment_provider_methods aws_money_write_gate_insert_payment_provider_methods: absent
policy public.payment_provider_methods aws_money_write_gate_update_payment_provider_methods: absent
policy public.payment_provider_methods aws_money_write_gate_delete_payment_provider_methods: absent
policy public.payment_sweep_configs aws_money_write_gate_insert_payment_sweep_configs: absent
policy public.payment_sweep_configs aws_money_write_gate_update_payment_sweep_configs: absent
policy public.payment_sweep_configs aws_money_write_gate_delete_payment_sweep_configs: absent
policy public.payment_transfer_groups aws_money_write_gate_insert_payment_transfer_groups: absent
policy public.payment_transfer_groups aws_money_write_gate_update_payment_transfer_groups: absent
policy public.payment_transfer_groups aws_money_write_gate_delete_payment_transfer_groups: absent
policy public.payment_transfers aws_money_write_gate_insert_payment_transfers: absent
policy public.payment_transfers aws_money_write_gate_update_payment_transfers: absent
policy public.payment_transfers aws_money_write_gate_delete_payment_transfers: absent
policy public.payment_wallet_sub_ledgers aws_money_write_gate_insert_payment_wallet_sub_ledgers: absent
policy public.payment_wallet_sub_ledgers aws_money_write_gate_update_payment_wallet_sub_ledgers: absent
policy public.payment_wallet_sub_ledgers aws_money_write_gate_delete_payment_wallet_sub_ledgers: absent
policy public.payment_wallets aws_money_write_gate_insert_payment_wallets: absent
policy public.payment_wallets aws_money_write_gate_update_payment_wallets: absent
policy public.payment_wallets aws_money_write_gate_delete_payment_wallets: absent
policy public.payroll_runs aws_money_write_gate_insert_payroll_runs: absent
policy public.payroll_runs aws_money_write_gate_update_payroll_runs: absent
policy public.payroll_runs aws_money_write_gate_delete_payroll_runs: absent
policy public.stakeholder_limit_requests aws_money_write_gate_insert_stakeholder_limit_requests: absent
policy public.stakeholder_limit_requests aws_money_write_gate_update_stakeholder_limit_requests: absent
policy public.stakeholder_limit_requests aws_money_write_gate_delete_stakeholder_limit_requests: absent
policy public.tenant_bank_accounts aws_money_write_gate_insert_tenant_bank_accounts: absent
policy public.tenant_bank_accounts aws_money_write_gate_update_tenant_bank_accounts: absent
policy public.tenant_bank_accounts aws_money_write_gate_delete_tenant_bank_accounts: absent
policy public.tenant_billing_accounts aws_money_write_gate_insert_tenant_billing_accounts: absent
policy public.tenant_billing_accounts aws_money_write_gate_update_tenant_billing_accounts: absent
policy public.tenant_billing_accounts aws_money_write_gate_delete_tenant_billing_accounts: absent
policy public.tenant_credit_balances aws_money_write_gate_insert_tenant_credit_balances: absent
policy public.tenant_credit_balances aws_money_write_gate_update_tenant_credit_balances: absent
policy public.tenant_credit_balances aws_money_write_gate_delete_tenant_credit_balances: absent
policy public.tenant_credit_transactions aws_money_write_gate_insert_tenant_credit_transactions: absent
policy public.tenant_credit_transactions aws_money_write_gate_update_tenant_credit_transactions: absent
policy public.tenant_credit_transactions aws_money_write_gate_delete_tenant_credit_transactions: absent
policy public.tenant_maintenance_payments aws_money_write_gate_insert_tenant_maintenance_payments: absent
policy public.tenant_maintenance_payments aws_money_write_gate_update_tenant_maintenance_payments: absent
policy public.tenant_maintenance_payments aws_money_write_gate_delete_tenant_maintenance_payments: absent
policy public.tenant_wallet_funding_settings aws_money_write_gate_insert_tenant_wallet_funding_settings: absent
policy public.tenant_wallet_funding_settings aws_money_write_gate_update_tenant_wallet_funding_settings: absent
policy public.tenant_wallet_funding_settings aws_money_write_gate_delete_tenant_wallet_funding_settings: absent
```

That is `6b404964de5ee203e126bc3ce78395c9a9e2fbf3a1e41eb0b5ccd8fa3e3ea150`, derived by `aws/tests/release-sql136-executor.test.mjs` and read back from a PostgreSQL 16
database with the 24 tables as the repository leaves them. Each pin records its own environment's read;
neither value is written into a pin before a run reads it. A pre-state other than this one is a stop.

## Preconditions (both environments; production adds the pinned `checksops_admin` login)

`prerequisites_present` (the 24 tables, `aws_moov_onboarding_active()`, `aws_moov_webhook_apply_active()`,
roles `checksops` and `authenticated`); `altered_relations_owned_by_login` (CREATE POLICY needs the
owner of each of the 24 tables); `functions_owned_by_login` and `function_acl_replaceable` (on a re-run);
`money_tables_not_forced_rls`, `money_definer_writers_bypass_rls`, `no_invoker_trigger_money_writers`
(counts `money_tables_forced_rls`, `money_definer_writers_without_bypass`, `money_invoker_trigger_writers`
all 0).

Post-conditions: the intended fingerprint; the function owned by the login; everything else in schema
`public` (and the functions of `auth`) unchanged. The tools roll back otherwise.

## Steps

0. The API first (above), in the environment the next step runs in. Record the run ids.
1. Staging: the staging executor must carry SQL 136 first (executor package refresh through the guarded
   staging executor `deploy` mode, its own reviewed run). Then run the guarded staging SQL executor with
   `read-live` for `sql136-money-write-restrictive-policies`. Expected: `already_applied` false,
   `precondition_failures` `[]`, the three stop counts 0, `live_definition_sha256` `6b404964…` (above).
   If it reports `prerequisites_missing` other than `[]`, `precondition_failures` other than `[]`, a stop
   count other than 0, a non-zero `money_invoker_function_writers` not yet reviewed, or another
   pre-state, stop. Otherwise record `LIVE_DEFINITION_SHA256` in the staging pin
   (`expected_live_definition_sha256`, owner-approved `authorization`, `execute: true`) in a reviewed
   change, `apply`, then `read-live` again, and have the owner exercise the staging money flows (billing,
   collection, invoices, wallet sync, payee and onboarding) before production.
2. Production: run the read-only inspect on the runner
   (`node scripts/deployment-guard/production-sql-one-shot.mjs --migration sql136 … --phase inspect`);
   record `production_inspect` and copy `live_definition_sha256` into
   `expected_live_definition_sha256`; record the staging runs and the API rollout in
   `staging_acceptance`; set an owner-approved `authorization` and `execute: true`, in one reviewed change.
3. Apply with the one-shot (`ops/production-sql-one-shot.md`): `production-sql-one-shot.mjs
   --migration sql136 --approval-scope sql136 … --phase apply` with the owner's words (authorization
   phrase `APPLY_MONEY_WRITE_RESTRICTIVE_POLICIES`).
4. Record the apply and retire the pin (`execute: false`).

**Revert (if a money flow breaks after the apply).** A new reviewed migration through the same guarded path
drops the 72 `aws_money_write_gate_*` policies (and the function); the permissive policies were never
touched, so that restores today's behaviour exactly. Never drop them by hand.
