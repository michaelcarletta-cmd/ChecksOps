# Provider sandbox validation

This phase validates AWS provider adapters against **safe sandbox/test environments only**.

It does **not** authorize:

- production money movement
- production provider execution
- production webhook cutover
- production DNS changes
- production frontend cutover

Production remains:

```
AWS_PROVIDER_EXECUTION_ENABLED=false
AWS_FINANCIAL_PERMISSIONS_ACTIVATED=false
AWS_MOOV_ENABLED=false
AWS_CHECKALT_ENABLED=false
AWS_PLAID_ENABLED=false
```

Sandbox HTTP, when allowed, uses a **separate** flag:

```
AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED
```

That flag must never be reused as the production master execution switch.

## Capability (inspected on current main after PR #99)

| Provider | Sandbox available on AWS staging? | Safe operations without production accounts |
| --- | --- | --- |
| Moov | **No.** `checksops/staging/providers` has no `MOOV_SANDBOX_*` keys. Production Edge Functions use separate sandbox keys, but those values were not copied to AWS and must not be extracted from production. Moov sandbox and production share `https://api.moov.io`; the **keys** select the ledger. | OAuth, account/wallet/method/capability reads, $0.01 sandbox transfer, retrieve, idempotent retry, sandbox webhook — only after dedicated sandbox keys and sandbox object mappings exist. |
| CheckAlt | **UAT only.** Require `CHECKALT_UAT_*` against `https://uatapi.checkalt.com` (merchant `lockbox5`). Production `CHECKALT_*` and any other host are refused. | Auth, user/deposit account reads, synthetic-image test deposit, history/status, approve only if UAT requires it. Do not submit a negotiable check. |
| Plaid | **No dedicated sandbox keys on AWS.** Plaid has `https://sandbox.plaid.com`, but Link is account-connection, not the deposit→disburse money path. | Link token, public-token exchange, webhook verification only. No transfers. |

RDS Freedom/C1C `payment_provider_accounts` / wallets are labeled **`production`**. Those IDs must not be overwritten with sandbox IDs and must not be used to place a “sandbox” transfer.

## Isolation

Sandbox state lives only in:

- `aws_provider_sandbox_objects`
- `aws_provider_sandbox_operations`
- `aws_provider_sandbox_audit`
- `aws_provider_sandbox_webhooks`

Never written by this phase:

- `payment_provider_accounts`
- `payment_wallets`
- `payment_transfers`
- `checkalt_deposits`
- `claim_payments`
- `homeowner_ledger_events`

Webhook tenant mapping uses **sandbox objects only**. Payload `tenant_id` / `user_id` are ignored. Production webhook URLs stay on Supabase.

## Amounts and API versions

| Provider | Unit | Smallest safe test |
| --- | --- | --- |
| Moov | `amount.value` integer USD cents | `1` ($0.01) |
| CheckAlt | `userAmount` integer cents | `1` |

Moov request pin in the AWS sandbox adapter: `x-moov-version: v2024.01.00` (same as the production Edge client). Documented amount API: v2026.04.00 / v2026.07.00 integer cents. `X-Idempotency-Key` is a stable UUID hashed from the ChecksOps operation key.

Browser-supplied amounts are rejected. Server derives tenant, application user, sandbox objects, amount, and authorization.

## Routes

- `GET /sandbox/status`
- `POST /sandbox/isolation` (must pass before provider HTTP)
- `POST /sandbox/moov/probe`
- `POST /sandbox/moov/transfer`
- `POST /sandbox/moov/retrieve`
- `POST /sandbox/checkalt/probe`
- `POST /sandbox/checkalt/account`
- `POST /sandbox/checkalt/deposit`
- `POST /sandbox/checkalt/status`
- `POST /sandbox/checkalt/approve`
- `POST /sandbox/plaid/probe`
- `POST /sandbox/reconcile`
- `POST /sandbox/cleanup`
- `POST /sandbox/webhooks/{moov,checkalt,plaid}`

## What must be loaded before real sandbox HTTP

Populate Secrets Manager `checksops/staging/providers` with **sandbox-only** keys (never production):

- `MOOV_SANDBOX_PUBLIC_KEY`
- `MOOV_SANDBOX_SECRET_KEY`
- `MOOV_SANDBOX_PLATFORM_ACCOUNT_ID`
- `MOOV_SANDBOX_ALLOWED_ORIGIN`
- `MOOV_SANDBOX_WEBHOOK_SECRET`
- CheckAlt UAT: `CHECKALT_UAT_BASE_URL` (exactly `https://uatapi.checkalt.com`), `CHECKALT_UAT_USER_ID`, `CHECKALT_UAT_PASSWORD`, `CHECKALT_UAT_FI_KEY`, `CHECKALT_UAT_MERCHANT` (`lockbox5`)
- Optional Plaid: `PLAID_SANDBOX_CLIENT_ID` / `PLAID_SANDBOX_SECRET`

Then map sandbox payment methods into `aws_provider_sandbox_objects` for the staging tester tenant. Do not copy production Moov account IDs into that table.
