# M7.0 — Controlled Moov transfer readiness audit

**STOP FOR REVIEW.** Read-only / design only. Do not enable money execution.
Do not create a transfer or disbursement. Do not apply SQL72. Do not submit
Financial TOTP. Do not neutralize the legacy `moov-disburse` bypass in this
phase.

M6.4 recipient onboarding is complete and the bank-verify write window is
closed. This phase inventories remaining money rails and names the gaps that
must close before **one** tightly controlled Freedom Moov transfer can be
authorized.

## Live holds (unchanged)

| Flag | Live `checksops-production-prep-api` |
|---|---|
| `AWS_MOOV_ENABLED` | `false` |
| `AWS_PROVIDER_EXECUTION_ENABLED` | `false` |
| `AWS_FINANCIAL_PERMISSIONS_ACTIVATED` | `false` |
| `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED` | `false` |
| `AWS_CHECKALT_ENABLED` | `false` |
| `AWS_PROVIDER_RECIPIENT_BANK_VERIFY_WRITES_ENABLED` | `false` |
| `AWS_PROVIDER_LIVE_READS_ENABLED` | `true` (GET only) |
| `AWS_PROVIDER_WEBHOOK_DRY_RUN` | `true` |

CodeSha256 `ZJsY9c2HBHmBLsri4U8Yq0mbUg/j/eupd0YlbBJ1AmM=` (unchanged since
M6.4F.3). `payment_transfers=0`. Recipient Chase ••••1506 remains verified.

## 1. Legacy money-rail inventory

Production-capable Moov **create** paths still in the Lovable/Supabase plane:

| Path | Trigger | Can create/retry a real Moov transfer? |
|---|---|---|
| `supabase/functions/moov-disburse` | SPA `functions.invoke` **and** internal header | **YES** — `POST /transfers` |
| `process-funded-payment` | `moov-webhook` on funding `completed`, or internal | Does not POST Moov itself; **invokes `moov-disburse` with bypass** |
| `moov-webhook` | Moov HTTPS | Status sync; on funding complete **originates** the send chain above |
| `moov-transfer-create` | SPA `moovProvider` | YES, gated by `requireMoovCaller` (`MOOV_ENABLED`) |
| `moov-transfer-group-create` | SPA splits | YES |
| `moov-wallet-fund` | SPA wallets | YES |
| `initiate-wallet-funding` | SPA DisbursementConsole / auto-funding | YES ACH debit |
| `wallet-fund-on-clear` | Cron or SPA pull | YES; retries ≤5 with per-row idempotency |
| `moov-tenant-fee-charge` | Admin SPA | YES (admin caller) |
| `homeowner-deductible-pay` | Public ledger token | YES; own `MOOV_ENABLED` check, **no** Financial TOTP |

`moov-transfer-status` / `moov-selftest` do not create transfers.

### Legacy `moov-disburse` internal bypass — STILL EXISTS

`x-checksops-internal` equal to `SUPABASE_SERVICE_ROLE_KEY` skips
`requireMoovCaller`. That skip is **no `MOOV_ENABLED`**, no tenant allowlist,
no user session, no Financial TOTP. Both paths still `POST` Moov `/transfers`.

```50:68:supabase/functions/moov-disburse/index.ts
    const internalKey = req.headers.get("x-checksops-internal");
    const isInternal = Boolean(internalKey) &&
      internalKey === Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    // ...
    if (isInternal) {
      supabase = svc;
      environment = (Deno.env.get("MOOV_ENVIRONMENT") ?? "sandbox").toLowerCase();
```

Webhook auto-send chain:

```434:444:supabase/functions/moov-webhook/index.ts
  if (fundingStatus === "completed") {
    await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/process-funded-payment`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-checksops-internal": Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
```

Live Edge `POST /functions/v1/moov-disburse` with a dummy batch id returns
HTTP **404** `Disbursement batch not found` (function is deployed; dummy id
fails before Moov POST). This phase did **not** present the internal header
and did **not** create a transfer.

Current residual auto-send fuel: `wallet_funding_requests=0`. Freedom
`disbursement_batches` are `completed` (111) or `failed` (7) with
`auto_send_after_funding=false`. Historical splits have `moov_transfer_id=null`
(other rails). Bypass code remains live anyway.

### SPA legacy money calls — YES

`src/components/disbursement/DisbursementConsole.tsx` and
`src/components/payroll/RunPayrollDialog.tsx` still
`supabase.functions.invoke("moov-disburse")`. Also live: `moov-transfer-create`,
`moov-transfer-group-create`, `moov-wallet-fund`, `initiate-wallet-funding`,
`moov-tenant-fee-charge`, `homeowner-deductible-pay`.

## 2. AWS transfer contract

**There is no production AWS Moov transfer writer.** Closest code is sandbox
parity (`aws/functions/api/providers/parity/moov-money.mjs`). CheckAlt has
`providers/production/*` + `65_checkalt_production_writer.sql`. Moov has
nothing equivalent. There is **no** `aws/financial/sql/72_*.sql`.

When `AWS_PROVIDER_EXECUTION_ENABLED` **and** `AWS_MOOV_ENABLED` are both
true, `providers.mjs` returns **403 `production_execution_blocked`**
(`tranche4HardBlock`). Flipping those flags on **current** code does **not**
send money; it hard-blocks. Sandbox parity runs only if
`AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED=true` (must stay false in production).

Live overlay: `POST /functions/v1/moov-transfer-create` and `moov-disburse`
**crash-fail-closed** (`tenant-email-domain-handlers.mjs` missing from the
M6.4 historical zip). Do not deploy a zip merely to make this audit return a
clean 403.

| Contract item | Verdict | Notes |
|---|---|---|
| Server tenant | PARTIAL | Parity uses `ctx.tenantId`; not a production path |
| Server source/facilitator | PARTIAL | Facilitator resolved server-side; **platform id not in Lambda env or provider secret** |
| Server recipient/account/bank | PARTIAL | Browser Moov IDs not accepted; destination loaded from DB |
| Server amount | **NO** | `moov-transfer-create` uses `body.amount_cents` |
| Durable intent before POST | YES on transfer-create draft; PARTIAL on disburse | Draft insert environment is hardcoded **`sandbox`** |
| Deterministic idempotency | YES with caveat | Moov key `checksops-transfer-${draft.id}`; client may override business key |
| CAS / concurrency | **NO** | No `provider_http_attempted_at` CAS (unlike CheckAlt production) |
| Unknown-outcome / no blind second POST | **NO** | Timeout marks draft `failed` and returns 502 |
| Provider ref persisted | YES after success | |
| Status poll/webhook updates existing intent | YES in sandbox apply | Production-environment rows are skipped |

Recipient Chase ••••1506 is **not** a `payment_provider_methods` row
(`external_recipient_id` lookup would 409 `recipient_setup_required`).
Parity `loadConnectedMethod` for a tenant source filters
`environment = 'sandbox'`; Freedom’s Wells Fargo method is `production`.

## 3. Financial TOTP

Proven app-level TOTP exists for **CheckAlt `deposit.submit` only**.
`resolveFinancialStepUpBinding` 409s any other `action_key`. Bound: user,
tenant-from-check, action, `check_id`, server amount, 30-minute step-up TTL,
TOTP `last_used_timestep`. **Not** bound: transfer/disbursement id, recipient,
Moov payment-method ids.

Live `financial_stepup_log` (2 rows): `totp.enroll`, `deposit.submit`. No
transfer authorization exists. Step-up **log row is reusable within 30 minutes**.

Required for a first Moov transfer (not implemented): application user, tenant,
action `transfer.create` (or equivalent), intended transfer/disbursement,
recipient, server-authoritative amount, short TTL, **single-use** step-up
row. Do not create a new authorization in this phase.

## 4. First-transfer hard cap (design)

**None** exists beyond global `MIN_PROVIDER_AMOUNT_CENTS=1` and
`MAX_PROVIDER_AMOUNT_CENTS=100_000_000` ($1,000,000).

Recommend a **server-enforced first-transfer maximum of 1 cent ($0.01)** —
the runbook’s sandbox smoke amount. Browser amount is ignored. Enforce in the
future production writer **before** Moov POST. Do not enable it yet.

## 5. Funding / source (read-only)

| Role | Record |
|---|---|
| Freedom tenant | `2eff5f1a-929d-4ce3-9a8b-cd96b98df42a` |
| Freedom Moov business account | `60922058-7eca-4889-81dd-5720d7b9de96` (production, KYC verified, ToS 2026-08-28, `can_send_payments=true`, **`can_ach_debit=false` on account snapshot**) |
| Freedom operating wallet | `3e6286ca-a19c-45f6-aad9-f73dac5f0358` — **available_cents=0**, pending 0 |
| Freedom funding bank | Wells Fargo checking ••••4573, verified, connected; rails `ach-credit-standard`, `ach-credit-same-day`, **`ach-debit-fund`** (`a02c1c81-9ca6-434d-accc-ea4471a70ef2`) |
| Platform / facilitator bank row | Chase ••••7649, `is_platform=true`, Moov account `41cb5d67-4911-4bef-aad5-d8ee9c582208` |
| Recipient | `62a858ff-ee6a-49d7-9898-1c8e4a44227b` on Freedom tenant, `onboarding_status=ready` |
| Recipient Moov account | `ee8c608e-dc2d-45d3-95e9-3c992f3dfc5f` (production, KYC verified, ToS, bank verified) |
| Recipient bank | `72eb66c1-d9a9-4f85-ab50-8871db9ceeea` JPMORGAN CHASE BANK, NA ••••1506, `/verify=successful` |
| Recipient Moov payment methods | **5** (live GET). **0** rows in `payment_provider_methods` |

AWS provider secret has `MOOV_ENVIRONMENT=production` plus API keys. It does
**not** contain `MOOV_PLATFORM_ACCOUNT_ID` or `MOOV_WEBHOOK_SECRET`. Facilitator
resolution would fall back to wallet `partnerAccountID` at send time.

Expected first-test path (design): Freedom Wells Fargo ••••4573
`ach-debit-fund` **or** funded wallet → facilitator `POST /transfers` →
recipient Chase ••••1506 ACH credit (`ach-credit-standard` unless same-day is
explicitly chosen). ACH timing is standard 1–3 business days or same-day if
selected. **Fees are not exposed** in these GET snapshots.

Wallet balance **$0** plus account-snapshot `can_ach_debit=false` vs method
rail `ach-debit-fund` must be reconciled with a GET-only Moov capability
read in a later preflight — still no transfer in this phase.

## 6. Webhook + reconciliation

| Item | Finding |
|---|---|
| Production Moov webhooks | Still on **Supabase** (`payment_webhook_events=276`) |
| AWS webhook secret | **Absent** from Lambda env and provider secret |
| AWS signature validation | Implemented (`hmac.mjs` HMAC-SHA512, 5-minute skew) but unused without secret + DNS |
| Event idempotency | AWS unique `(provider, external_event_id)` `ON CONFLICT DO NOTHING` |
| Tenant binding | Provider account id; payload `tenant_id` ignored |
| AWS apply | Sandbox rows only; production-environment rows skipped |
| AWS webhook can originate a transfer? | **NO** |
| Supabase `moov-webhook` can originate a send? | **YES** via `process-funded-payment` → bypass |

Do not rotate secrets in this phase.

## 7. SQL72 / activation

- **SQL72 file does not exist.** Named hold only.
- `64_financial_activation_grants.sql` is `SELECT 'NOT_APPLIED'` / DO NOT APPLY.
- `65_checkalt_production_writer.sql` is CheckAlt-only; do not apply.
- CI (`aws-migration-ci.yml`) refuses auto-apply of 64/65.
- Templates keep money flags `"false"`.

Minimum **future** sequence (after a production writer exists — not now):

1. Neutralize or dual-control the legacy `moov-disburse` bypass (later reviewed phase).
2. Persist recipient payment-method rows / production `loadConnectedMethod`.
3. Bind Financial TOTP to the transfer (recipient + server amount + one-time).
4. Server first-transfer cap (1 cent).
5. CAS + unknown-outcome reconcile (no blind second POST).
6. AWS-specific webhook secret + dry-run dual-delivery; webhook still must not originate money.
7. Human-apply activation SQL **only if a Moov writer exists** (today it does not).
8. Narrow flag window last — **not** the current hard-block pair alone.

Do **not** apply SQL64/65/72. Do not change flags.

## 8. Proposed first real test (DO NOT EXECUTE)

1. **Preflight (GET-only):** flags still false; recipient still verified; Freedom source rails; wallet/debit capability reconciled; no in-flight `wallet_funding_requests`; dummy AWS transfer still fail-closed.
2. **Contract work in later reviewed PRs** (still flags false): production writer, TOTP transfer binding, 1-cent cap, CAS/unknown-outcome, recipient method persistence, bypass containment.
3. **Financial TOTP** for that one bound 1-cent Freedom → Chase 1506 intent (human). Do not enroll/submit in this phase.
4. **Narrow execution enablement** only after the writer exists and review signs it — never sandbox-execution on production.
5. **One** transfer POST under deterministic idempotency.
6. **Immediate STOP** — disable the execution window.
7. Verify Moov transfer id, DB intent row, no second POST.
8. Verify webhook/receipt updates **that** intent only.
9. Verify amount, source, destination, balances; `payment_transfers=1` then freeze.
10. Leave all money flags false again.

## Holds

Do not enable Moov / CheckAlt / provider execution / financial-permissions /
sandbox-execution. Do not create a transfer. Ready to **design** the missing
production writer and TOTP/cap work; **not** ready to enable money.
