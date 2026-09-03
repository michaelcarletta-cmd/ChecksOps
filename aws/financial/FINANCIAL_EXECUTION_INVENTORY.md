# Financial execution inventory

Authoritative codebase: current `main` after PR #98 (Tranche 5), SHA `2645d9c54a539ed6981597b3f575428553550b6b`.

This inventory traces production money paths. AWS staging certifies the architecture only. **No production provider transaction is authorized.**

Master production guard: `AWS_PROVIDER_EXECUTION_ENABLED=false`. All provider flags remain false.

## Money lifecycle (eventual production)

```
Check created / uploaded
  → internal review / endorsing / loss-draft (T5)
  → approved_for_deposit / ready_for_deposit
  → CheckAlt deposit submit
  → CheckAlt pending / submitted
  → CheckAlt cleared (webhook / poll)
  → deposited / available funds on tenant
  → wallet / bank funding (Moov)
  → disbursement batch + splits
  → ACH / RTP / (wire documented, not a current primary rail)
  → completed / settled
  → returns / reversals / failed retries
```

AWS T5 stops at `approved_for_deposit`. This phase adds a **simulated** provider operation machine on `aws_financial_*` tables only. It does not write `checkalt_deposits`, `payment_transfers`, or disbursement ledgers.

## Unit conventions

| Provider | Stored | Sent to provider | Example |
| --- | --- | --- | --- |
| CheckAlt | `check_intake_items.amount` / `checkalt_deposits.amount` dollars | integer cents `userAmount` | `123.45` → `12345` |
| Moov | `*_cents` integer | `amount.value` integer cents (API v2026.04.00 / v2026.07.00) | `$123.45` → `{ currency: "USD", value: 12345 }` |
| Plaid Transfer | split `amount` dollars in `disbursement_splits` | Plaid Transfer amount (production Edge Function); AWS disabled | not executed |
| Actum | `actum_transactions` remnants | no Edge Function on current main | interface only |
| QuickBooks | payment amount dollars | QuickBooks payment create | disabled |

Moov `amount.valueDecimal` exists on newer API versions as a dollar string. ChecksOps execution must keep using integer cents `value`, matching current production `moov-transfer-create`.

Browser-supplied amounts are rejected. Server amount sources: `check_intake_items.amount`, or the sandbox certification fixture `12345` cents when a T5 synthetic check has no amount.

## Paths

### 1. CheckAlt deposit submit

| Field | Value |
| --- | --- |
| UI | `CheckCommandCenter` / `DepositOperationsConsole` → `guardFinancial("deposit.submit")` then `checkalt-submit-deposit` |
| API | `supabase/functions/checkalt-submit-deposit` |
| Tables | `check_intake_items`, `checkalt_tenant_accounts`, `checkalt_deposits`, storage images |
| Amount | check amount → integer cents `userAmount` |
| Tenant | server membership / RLS, not browser `tenant_id` |
| Auth today | tenant member + frontend step-up. `has_permission()` is CRUD only |
| Provider account | `checkalt_tenant_accounts.sso_user_id` |
| Idempotency | check + integer-cents amount + reference |
| Internal state | deposit `submitted` / `pending_approval` |
| Webhook | CheckAlt status → cleared / returned / rejected |
| Failure | image/API error; deposit row failed/rejected |
| Retry | re-submit same check+amount must not double-deposit |
| Reversal | CheckAlt return |
| AWS | T4 `403 provider_disabled`. T6 simulate-only on `aws_financial_operations` |

### 2. CheckAlt approve / poll

| Field | Value |
| --- | --- |
| UI | `CheckAltSettings` → `guardFinancial("deposit.approve")` |
| API | `checkalt-approve-deposit`, `checkalt-poll-status` (poll **updates** `checkalt_deposits`) |
| AWS | disabled. Poll is not a pure read |

### 3. Deposit batches / items (legacy RDC)

| Field | Value |
| --- | --- |
| Tables | `deposit_batches`, `deposit_items`, `deposit_provider_attempts`, `deposit_exceptions`, `deposit_webhook_events` |
| UI | Deposit operations console |
| AWS | read-only aggregates. No execution |

### 4. Moov transfer (ACH / RTP / wallet)

| Field | Value |
| --- | --- |
| UI | payments / stakeholder pay |
| API | `moov-transfer-create` |
| Tables | `payment_provider_accounts`, `payment_provider_methods`, `external_payment_recipients`, `payment_transfers`, `payment_idempotency_keys`, `payment_event_log` |
| Amount | `amount_cents` → Moov `{ currency, value }` integer cents |
| Tenant | `requireMoovCaller`; payer account must be the initiating tenant |
| Auth today | platform admin **or** tenant `owner`/`admin`/`manager` |
| Source | tenant bank debit method |
| Destination | other tenant account or `external_payment_recipients` owned by tenant |
| Idempotency | `tenant:destination:amount:check|claim|adhoc` + unique `(tenant_id, idempotency_key)` |
| State | `ready` → created/pending → completed / failed |
| Webhook | `moov-webhook` / AWS `POST /webhooks/moov` (dry-run) |
| Rails | `selectRail` standard ACH, same-day, RTP when `requested_speed=instant` and under RTP cap |

### 5. Wallet funding

| Field | Value |
| --- | --- |
| API | `initiate-wallet-funding`, `moov-wallet-fund`, `cancel-wallet-funding`, `process-funded-payment`, `wallet-fund-on-clear`, `calculate-payment-funding` |
| Tables | `payment_wallets`, `payment_wallet_ledger`, funding request rows |
| Cancel | production-supported for wallet funding |
| AWS | disabled |

### 6. Disbursement batches / splits

| Field | Value |
| --- | --- |
| UI | `DisbursementConsole` → `guardFinancial("disbursement.send")` |
| API | `moov-disburse`, `plaid-disburse` |
| Tables | `disbursement_batches` (`check_amount`, `amount_reserved_cents`, `rail`, `funding_status`), `disbursement_splits` (`amount`, `idempotence_key`, `plaid_transfer_id`) |
| Payees | homeowner / contractor / vendor / stakeholder via splits |
| AWS | local Plaid split **reads** only. Execution disabled |

### 7. Homeowner / contractor / stakeholder

| Path | API | Notes |
| --- | --- | --- |
| Homeowner deductible | `homeowner-deductible-pay` | money movement, disabled |
| Homeowner bank link | `homeowner-bank-link-send` | email + Plaid, disabled |
| Contractor/vendor | disbursement splits + Moov/Plaid | disabled |
| Stakeholder | `moov-recipient-*` + transfer | KYC/TOS/bank gates. Execution disabled |

### 8. Fees, returns, reversals, failures, duplicates

| Concern | Production model | AWS |
| --- | --- | --- |
| Platform fee | `platform_fee_cents` on `payment_transfers`; `moov-tenant-fee-charge` | disabled |
| Return | Moov/CheckAlt webhook → `returned` | simulated webhook only |
| Reversal | Moov `reversed` | simulated webhook only |
| Failed payment | transfer/deposit `failed`/`rejected` | simulated failure classes |
| Duplicate submit | unique idempotency + webhook event id | certified on `aws_financial_operations` |
| Webhook-driven state | provider webhooks, not browser status | production-style dry-run + sandbox synthetic apply on staging cert tables |

### 9. QuickBooks / Actum / Plaid bank link

| Provider | Money path | AWS |
| --- | --- | --- |
| QuickBooks | `quickbooks-payment` | disabled |
| Actum | no `actum-*` function; table remnants | interface only |
| Plaid Link | `plaid-link-token-*`, `plaid-exchange` | disabled (account connection) |

## What AWS may write in this phase

| Table | Write? |
| --- | --- |
| `aws_financial_operations` | yes, simulated |
| `aws_financial_audit` | insert only |
| `aws_financial_reconciliation_findings` | insert only, report |
| `aws_provider_webhook_receipts` | T4 dry-run receipts |
| `checkalt_deposits` / `payment_transfers` / disbursement / ledger | **no** |
