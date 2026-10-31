# Money-write flag (finding 14, step 1 of 2)

Status: **step 1 (API) prepared, not deployed. Step 2 (SQL 136) not written.**

Security audit 2026-10-29, finding 14 (medium): SQL 90 made `aws_can_write_tenant()` plain
tenant membership, so the SQL 24 `FOR ALL TO authenticated USING/WITH CHECK
aws_can_write_tenant(tenant_id)` policies let any tenant member's API session write the money
tables, and the gated SQL 72 / SQL 91 policies add nothing. Owner decision 2026-10-31 (a): fix it
in two steps, the API first, then SQL 136.

## Step 1: what the API now does

`aws/functions/api/money-write-flag.mjs` exports `setMoneyWriteFlag(client)`, which runs

```sql
SELECT set_config('request.money_write', '1', true)
```

in the caller's open transaction (transaction-local; it ends at COMMIT/ROLLBACK). `'1'` matches
the other server-only GUCs (`request.financial_execution`, `request.moov_onboarding`,
`request.provider_webhook_apply`), which SQL compares with `= '1'`. The name is new: no SQL file
or other API module uses it (`aws/tests/money-write-flag.test.mjs`).

- The browser sends no SQL, so it cannot set a GUC. The generic `/data/write` route
  (`write.mjs`, `write-check-workflow.mjs`) never sets the flag and still refuses every money table
  (`table_not_allowlisted`); tested for all 24 tables and four ops.
- Nothing reads the flag yet: this PR is behavior-neutral. Where the write that follows swallows
  its own error (`.catch(() => {})`), the flag call does too, so an aborted transaction fails where
  it did before.
- A flag set inside a SAVEPOINT that is rolled back is cleared, so each flag call sits outside any
  savepoint its write could roll back (invoice lifecycle: before `SAVEPOINT invoice_customer` /
  `invoice_sync_row`).

## Table x write path x gate (what SQL 136 relies on)

"flag" = `request.money_write = '1'` set by this PR. "SQL 72" = `request.financial_execution = '1'`.
"SQL 91 onboarding" = `request.moov_onboarding = '1'` (`aws_moov_onboarding_active()`). "SQL 91
webhook" = `request.provider_webhook_apply = '1'` (`aws_moov_webhook_apply_active()`). "definer" =
a SECURITY DEFINER function owned by the table owner (no FORCE RLS), which RLS does not apply to.

| table | API write path | gate (where it is set) |
|---|---|---|
| `moov_invoices`, `moov_invoice_customers` | `invoice-provider.mjs` `runProviderInvoiceAction` (recover, create, create_and_send, send, resend, sync, cancel, delete; `persistInvoiceCustomer`), reached from `invoice-actions.mjs` `runInvoiceAction` by production `providers/production/moov-invoice.mjs` and the staging parity `invoice` handler | flag: `invoice-provider.mjs`, once after the read-only `preflight`/`list` branches and before any write or savepoint (staging also via the parity dispatch) |
| `payment_provider_methods` | parity `moov-onboard.mjs` (bank add, micro-deposit initiate/confirm, recipient bank add/verify, disconnect), parity `moov-rails.mjs` `saveMethodRails` (from `moov-money.mjs`) | flag: `providers/parity/moov-functions.mjs` `wrap`, before every write-mode `handler.run` (never on the read-only production sweep path) |
| | `providers/onboarding/handlers.mjs` (`pullMoovStatus`, bank add / micro-deposits), `providers/onboarding/moov-sync.mjs` `forgetGoneAccount` | SQL 91 onboarding (`handlers.mjs` submit dispatch and `commitAndContinue`) |
| | `providers/webhook-apply.mjs` (sandbox webhook) | SQL 91 webhook |
| | SQL 113 payee functions (`aws_payee_disconnect`, `aws_public_payee_record`) | definer |
| `payment_method_verifications` | parity `moov-onboard.mjs` micro-deposits / recipient bank verify | flag (parity dispatch) |
| | `providers/onboarding/handlers.mjs` | SQL 91 onboarding |
| `external_payment_recipients` | parity `moov-onboard.mjs` recipient create / session / ToS / bank add / disconnect | flag (parity dispatch) |
| | `providers/webhook-apply.mjs` | SQL 91 webhook |
| | SQL 113 payee functions | definer |
| `payment_wallets` | parity `moov-wallet.mjs` `syncWallet` (parity wallet, sweep and money handlers) | flag (parity dispatch) |
| | `moov-wallet.mjs` `syncWalletReadOnly` from `providers/production/moov-wallet-sync.mjs` | flag (`moov-wallet-sync.mjs`, after its SQL 72 GUCs) |
| | `syncWalletReadOnly` from `providers/production/moov-wallet-fund.mjs`, `moov-send.mjs` | SQL 72 only (see uncovered 1) |
| `payment_transfers` | parity `db.mjs` `insertTransferDraft` / `updateTransferAfterMoov` (from `moov-money.mjs`), `moov-functions.mjs` transfer status handler | flag (parity dispatch) |
| | `tenant-collection-v2.mjs` store `putLeg` | flag (before the insert / update) |
| | `tenant-collection-v2-settlement.mjs` and `tenant-billing-engine.mjs` `applyBillingProviderEvent` (provider webhook settlement and billing provider events) | flag (before the leg update) |
| | `providers/production/moov-wallet-fund.mjs`, `moov-send.mjs` | SQL 72 only (see uncovered 1) |
| | `providers/webhook-apply.mjs` | SQL 91 webhook |
| | SQL 109 `aws_moov_webhook_apply_transfer_status`, SQL 62 `aws_sandbox_apply_moov_transfer_status` | definer |
| `payment_transfer_groups` | `providers/webhook-apply.mjs` | SQL 91 webhook |
| `disbursement_splits` | parity `moov-money.mjs` disburse | flag (parity dispatch) |
| `check_billing_events` | `tenant-billing-engine.mjs` `persistMoovUsageForPeriod`, `accrueMortgageOpsAcceptedRequest`, `allocateInvoiceLines` | flag (before each write) |
| | `mortgage-ops-usage.mjs` `accrueMortgageOpsAcceptedRequest`, from `/data/rpc` `accept_mortgage_request` (`workflow-rpc.mjs`, inside `SAVEPOINT mortgage_ops_accrue`; RELEASE keeps the flag for the rest of that RPC, which writes nothing else) | flag (inlined statement: the module stays import-free) |
| | triggers `record_check_billing_event` (SQL 98), `aws_record_checkalt_billing_event` and `aws_record_send_speed_fee` (SQL 120) | definer |
| | trigger `tr_accrue_mortgage_ops_billing` / `tg_accrue_mortgage_ops_billing` | **unknown** (live-only, no repository SQL; see uncovered 2) |
| `tenant_maintenance_payments` | `tenant-billing-engine.mjs` `createOrGetOccurrence`, `submitOccurrence`, `createOrGetVerificationOccurrence`, `submitVerificationOccurrence`, `applyBillingProviderEvent`; `tenant-collection-v2.mjs` `putObligation`; `tenant-collection-v2-settlement.mjs`; `tenant-collection-v2-uat.mjs` fixture create / cleanup | flag (before each write) |
| `tenant_billing_accounts` | `tenant-settings-handlers.mjs` `saveTenantBillingAuthorization`, `toggleTenantAutoDebit`; `tenant-billing-handlers.mjs` authorize `pause`; `tenant-billing-engine.mjs` `saveBillingAuthorization` | flag (before each write) |
| `ach_authorizations`, `actum_transactions`, `claim_check_payments`, `micro_deposit_verifications`, `payment_sweep_configs`, `payment_wallet_sub_ledgers`, `payroll_runs`, `stakeholder_limit_requests`, `tenant_bank_accounts`, `tenant_credit_balances`, `tenant_credit_transactions`, `tenant_wallet_funding_settings` | **none**: no `INSERT`/`UPDATE`/`DELETE` in `aws/functions/api` (the sweep config handler writes only to Moov) | nothing to gate; SQL 136 can restrict them to the flag without breaking an API path |

FK cascades (for example a check delete removing its `mortgage_handling` billing event) are
referential actions, which RLS does not apply to. `aws/tests/money-write-flag.test.mjs` fails if a
new API file writes a money table without being classified above.

## Uncovered (step 2 must handle these; not silently skipped)

1. **`providers/production/moov-wallet-fund.mjs` and `moov-send.mjs`** (`payment_transfers`,
   `payment_wallets`). Not edited here (another open PR changes them). They set
   `request.financial_execution = '1'`, but `request.aws_financial_permissions_activated` follows
   `AWS_FINANCIAL_PERMISSIONS_ACTIVATED`, which the repository records as `false`, so
   `aws_financial_execution_active()` is false and these writes rely on SQL 24 today. SQL 136 must
   accept `current_setting('request.financial_execution', true) = '1'` on its own for these two
   tables (not only `aws_financial_execution_active()`), or a follow-up PR adds the flag to both
   files after the other PR lands. `moov-wallet-sync.mjs` had the same gap; it now sets the flag.
2. **`tg_accrue_mortgage_ops_billing`** (trigger `tr_accrue_mortgage_ops_billing` on
   `mortgage_handling_requests`, writes `check_billing_events`): no `CREATE` in repository SQL
   (`scripts/lib/justified-public-triggers.mjs`, `ops/production-mortgage-desk-access-inspect.md`).
   Its `prosecdef` and owner must be read by the step 2 inspect in both environments. If it is
   SECURITY INVOKER it fires on the accept UPDATE before the JS accrual sets the flag, and SQL 136
   would refuse it.
3. **Definer owners**: the definer rows above are safe only while each function's owner owns the
   table (no FORCE RLS) or bypasses RLS, and is not a member of `authenticated`. The step 2 inspect
   must confirm `proowner` / `relowner` / `relforcerowsecurity` for each.

## Step 2 (SQL 136): the policy shape

One **RESTRICTIVE** policy per command (never `FOR ALL`: a restrictive `FOR ALL` also filters
`SELECT`), `TO authenticated`, on each of the 24 tables, through one helper so the GUC list lives
in one place:

```sql
CREATE OR REPLACE FUNCTION public.aws_money_write_allowed()
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    current_setting('request.money_write', true) = '1'          -- this PR
    OR current_setting('request.financial_execution', true) = '1' -- SQL 72 writers (uncovered 1)
    OR public.aws_moov_onboarding_active()                        -- SQL 91 onboarding
    OR public.aws_moov_webhook_apply_active(),                    -- SQL 91 webhook apply
    false);
$$;
REVOKE ALL ON FUNCTION public.aws_money_write_allowed() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_money_write_allowed() TO checksops, authenticated;

-- for each money table <t>:
CREATE POLICY aws_money_write_gate_insert_<t> ON public.<t> AS RESTRICTIVE
  FOR INSERT TO authenticated WITH CHECK (public.aws_money_write_allowed());
CREATE POLICY aws_money_write_gate_update_<t> ON public.<t> AS RESTRICTIVE
  FOR UPDATE TO authenticated USING (public.aws_money_write_allowed())
  WITH CHECK (public.aws_money_write_allowed());
CREATE POLICY aws_money_write_gate_delete_<t> ON public.<t> AS RESTRICTIVE
  FOR DELETE TO authenticated USING (public.aws_money_write_allowed());
```

The permissive SQL 24 / SQL 72 / SQL 91 policies stay: they still decide *which tenant's* rows a
session may write; the restrictive policy decides that only a server path may write at all. No
platform-owner exemption is needed: platform-owner money writes go through the same flagged
handlers. Definer functions and FK actions are unaffected (above).

## Deploy order

The flag must be live in staging and production before SQL 136 is applied in either.

- Overlay plan (`ops/deployment-guard/production-api-overlay-plan.json`, manifest
  `aws/tests/fixtures/production-money-write-flag-manifest-2026-10-31.json`): ADD
  `money-write-flag.mjs` (ordered just before its first importer), then REPLACE
  `providers/production/moov-wallet-sync.mjs`, `providers/parity/moov-functions.mjs`,
  `tenant-settings-handlers.mjs`, `tenant-collection-v2-settlement.mjs`, `tenant-collection-v2.mjs`,
  `tenant-billing-engine.mjs`, `tenant-billing-handlers.mjs`, one guarded run each, in plan order.
- Not overlay members: `invoice-provider.mjs` (kept out of the plan), `mortgage-ops-usage.mjs`
  and `tenant-collection-v2-uat.mjs` (`do_not_overlay`). They are live (the first full-package
  rebuild added them) and reach a function again only with a rebuilt ZIP. Until they are, SQL 136
  would refuse invoice writes and the JS Mortgage Ops accrual (which its savepoint swallows).
