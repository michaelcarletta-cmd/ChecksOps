# M7.2 — Remaining Moov sequences without re-KYB/KYC

**STOP FOR REVIEW on remaining holds.** Do not POST a transfer without
Freedom-member TOTP. Do not PATCH the Freedom Sweep. Do not apply SQL72.
Do not re-request capabilities, KYC, KYB, or ToS. CheckAlt and Plaid
stay false. First transfer remains **1 cent**.

Freedom Adjustment, Condition One Commercial, and the ChecksOps
facilitator are **already authorized at Moov**. Re-requesting capabilities
or identity re-opens billed underwriting. This phase wires the remaining
ChecksOps sequences so they **reuse those accounts**.

## Operating model

`checksopsadmin@gmail.com` is **Tenant Management**. Mapped application email
(never JWT, never UUID) may:

1. **Pull fees** from other tenants for monthly and usage charges
   (`moov-tenant-fee-charge` → tenant `ach-debit-fund` → platform wallet)
2. **Issue refunds** from the platform balance back to a tenant wallet
   (`moov-refund`)

Tenant Management does **not** send partner, sub-contractor, vendor, or
homeowner payouts on a tenant's behalf. Those WALLET→RECIPIENT sends are
tenant-member only, from wallet available balance. CheckAlt is required
**only** when the payout names a ChecksOps deposit, check, or batch.

Every tenant can **see** their Moov wallet: available balance, pending in,
pending out, sweeps (and configure sweeps once money flags are on; **$0
retain is valid** and means auto-push the full wallet to the bank), whether
the account is verified and **what** is verified, and which bank is linked
to the Moov wallet.

```
Outside ChecksOps deposit (bank already Moov-linked)
  → TENANT BANK→WALLET (collect-funds tenants only)
  → TENANT WALLET → named payee (manual send; never auto-send)

ChecksOps-deposited check
  → CheckAlt clear (required)
  → optional TENANT BANK→WALLET
  → TENANT WALLET → named payee (manual send; never auto-send)
```

C1C has `send-funds` / `wallet` / `transfers` and **no** `collect-funds`.
Do **not** request `collect-funds`. C1C cannot be bank-debited or
fee-pulled until a human reviews that gap. They can still send from an
already-funded wallet.

## What this phase executed

| Sequence | Result |
|---|---|
| GET confirm Freedom / C1C / platform | GET only — no KYC POST |
| Capability family match | `send-funds` satisfies `send-funds.ach`; **never re-POST** |
| Discover/link vs create | Known merchants **409** `known_approved_account_must_be_linked` |
| Tenant Management authz | Mapped email `checksopsadmin@gmail.com` may pull fees and issue refunds; **cannot** send tenant payouts |
| AWS BANK→WALLET writer | Dark, fail-closed; tenant members only; 1¢ cap; **$0 Sweep retain does not block** the pull |
| AWS WALLET→RECIPIENT writer | Named already-verified payee; CheckAlt **only if** a ChecksOps deposit/check/batch is named; no bank fallback; **no internal bypass**; **not Tenant Management** |
| AWS fee pull | Dark, platform-owner only; 1¢ cap; C1C **409** `collect_funds_not_enabled` |
| AWS refund | Dark, platform-owner only; platform → tenant wallet; 1¢ cap |
| Tenant wallet visibility | Live GET `moov-wallet-status` / readiness / sweep-config when `AWS_PROVIDER_LIVE_READS_ENABLED`; never POSTs transfers or capabilities |
| `initiate-wallet-funding` | Refused (`use_separate_fund_and_disburse`) |
| `process-funded-payment` | `manual_send_required` — no auto-send |
| `wallet-fund-on-clear` | BANK→WALLET only after a cleared CheckAlt row |
| Sweep PATCH | **Not done** — no chosen retain minimum |
| Money flags / SQL72 / transfers | **Flags lifted 2026-09-14 on prep Lambda.** SQL72 not applied. No transfer POST yet (TOTP required) |

## Live GET confirmation (no KYC)

Ran production Moov **GET only** (OAuth client_credentials + GET account /
capabilities / banks). No capability POST, no account create, no Sweep PATCH,
no transfer.

| Party | Moov account | Live GET |
|---|---|---|
| Freedom Adjustment LLC | `60922058-7eca-4889-81dd-5720d7b9de96` | **verified**, ToS accepted, WF ••••4573 **verified**, `collect-funds` / `send-funds` / `transfers` / `wallet` **enabled** |
| Condition One Commercial Roofing LLC | `817e1bf0-e1f7-4e9e-95a8-ce15bfa31708` | **verified**, ToS accepted, `send-funds` / `transfers` / `wallet` **enabled** (no `collect-funds` — do **not** request it) |
| ChecksOps facilitator | `41cb5d67-4911-4bef-aad5-d8ee9c582208` | **verified**, ToS accepted, Chase ••••7649 **verified**, `transfers` enabled |
| Pay-setup recipient | `ee8c608e-dc2d-45d3-95e9-3c992f3dfc5f` | **verified**, ToS accepted, Chase ••••1506 **verified**, `send-funds` / `transfers` / `wallet` enabled |

`checksopsadmin@gmail.com` is **not** the email on those connected-account
profiles (Freedom is `claims@freedomadj.com`, platform is
`support@checksops.com`). Tenant Management is a ChecksOps login, not a
new Moov account. Do not create a Moov account or re-KYC to attach that
mailbox.

Platform list (`GET /accounts`, 7 connected accounts) also contains leftover
unverified duplicates (second Freedom `7c50c273-89ec-4651-addc-f27330fd4360`,
pipeline-test `7597a1f1-79c8-4c80-bbfd-fd5906c2bb73`). **Do not KYC or
capability-request those.** Writers refuse those ids.

Live prep Lambda CodeSha256
`ZJsY9c2HBHmBLsri4U8Yq0mbUg/j/eupd0YlbBJ1AmM=` (unchanged). Money flags all
**false**. `AWS_PROVIDER_LIVE_READS_ENABLED=true`.

`capabilityFlags` now treats family names as enabling `can_ach_debit` /
`can_ach_credit`. The stale RDS `can_ach_debit=false` snapshot is **not**
authority for the AWS writers — they GET live capabilities. Live-read
handlers now **cache** that GET into `payment_provider_accounts` and
`stakeholder_accounts.verification_status` so the UI matches Moov.

Payment readiness uses the **production** merchant for known approved
tenants (Freedom / C1C) even if a sandbox row still exists. Fee-plan GET is
not on the live-read allowlist; a missing code is **ready / provider-managed**,
not a missing onboarding step. Collect-funds is required only when Moov
already has that family — C1C without collect-funds is not treated as
incomplete, and ChecksOps still **never POSTs** it.

Michael Carletta's pay-setup recipient (`ee8c608e-…`, Chase ••••1506) is
verified at Moov. Live-read now writes `verification_status=verified` onto the
linked `stakeholder_accounts` / `external_payment_recipients` rows and the
stakeholder UI overlays that live GET so the badge matches Moov.

Required capabilities are **per operation**. Missing `collect-funds`
does not block WALLET→RECIPIENT. It does block BANK→WALLET and fee pull,
with `collect_funds_not_enabled` — never a capability POST.

## Fail-closed AWS writers

Reachable only when **all** of these are `true` (they stay **false** live):

- `AWS_MOOV_ENABLED`
- `AWS_PROVIDER_EXECUTION_ENABLED`
- `AWS_FINANCIAL_PERMISSIONS_ACTIVATED`
- `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED` **false** (ambiguous mode → 409)

Additional holds inside the writer (even if flags were lifted):

1. **No capability / KYC / account-create POST** (`moov_kyc_rerequest_blocked`)
2. First transfer **1 cent** (`first_transfer_cap`)
3. Financial TOTP bound to `wallet.fund`, `wallet.disburse`,
   `platform.fee_collect`, or `platform.refund` + tenant + amount + payment-method ids
4. Enabled Sweep with `minimumBalance <= 0` is **informational** (`sweepAutoPushesAll`); it does **not** block BANK→WALLET. If auto-push empties the wallet before send, WALLET→RECIPIENT fails with `wallet_balance_insufficient`.
5. WALLET→RECIPIENT refuses `x-checksops-internal` and `source_kind=bank`
6. WALLET→RECIPIENT requires a **named** already-verified payee of that tenant.
   CheckAlt is required **only** when `checkalt_deposit_id` / `check_intake_item_id` / `batch_id` is named; otherwise send from wallet available balance. `wallet-fund-on-clear` still requires a cleared CheckAlt row.
7. Fee pull and refunds require Tenant Management (`checksopsadmin@gmail.com`)
8. Fund/disburse refuse Tenant Management (`tenant_management_send_refused`)
9. Persist `payment_transfers` (`environment=production`) **before** HTTP; CAS
   `ready` → `submitting`; unknown/timeout → reconcile, never a second POST
10. Leftover duplicate account ids are denied (`denied_duplicate_account_do_not_kyc`)

## Sweep (live $0 retain is valid)

Freedom Sweep `2d2c900d-6efb-43a2-ba90-2fd77e22afdd` remains **enabled** with
minimum **`$0.00`**. That means auto-push **empties** the wallet to the
settlement bank. It is a valid treasury setting, not a product prerequisite
to use Moov. BANK→WALLET still pulls into the wallet; WALLET→RECIPIENT
needs available wallet balance (pause auto-push or keep a retain if you
want funds to sit there). **The live Freedom sweep was not PATCHed.**

## Live lift (2026-09-14)

Human ordered flag lift. Prep Lambda `checksops-production-prep-api`:

- CodeSha256 `fX9KOQi7vLmwPgOzig5EqvU1Ii+YeNYmIT6FNIAxuMQ=`
- `AWS_MOOV_ENABLED=true`
- `AWS_PROVIDER_EXECUTION_ENABLED=true`
- `AWS_FINANCIAL_PERMISSIONS_ACTIVATED=true`
- `AWS_CHECKALT_ENABLED=false`
- `AWS_PLAID_ENABLED=false`
- `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED=false`
- `AWS_PROVIDER_LIVE_READS_ENABLED=true`
- `AWS_PROVIDER_WEBHOOK_DRY_RUN=true`
- SQL64 / SQL72 **not** applied
- No Sweep PATCH, no KYC POST, no transfer POST yet

Unauthenticated `moov-wallet-fund` now returns `401 missing_cognito_token`
(not `provider_disabled`). First 1¢ still requires a Freedom tenant-member
Cognito JWT plus Financial TOTP bound to `wallet.fund` / `wallet.disburse`.

`checksops.com` still uses Supabase functions (`MOOV_ENABLED`). Lifting AWS
flags does not switch the Lovable UI onto these writers.

## GO / NO-GO

**GO** for AWS prep writers (1¢ cap, TOTP, no re-KYC). BANK→WALLET and
WALLET→ named payee are reachable on the prep Lambda once a Freedom member
completes TOTP.

**NO-GO** to PATCH Sweep, enable CheckAlt/Plaid, apply SQL64/SQL72, raise
the 1¢ cap, or POST a transfer from Tenant Management.
