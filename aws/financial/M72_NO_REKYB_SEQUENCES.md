# M7.2 — Remaining Moov sequences without re-KYB/KYC

**STOP FOR REVIEW.** Do not enable money flags. Do not POST a transfer. Do
not PATCH the Freedom Sweep. Do not apply SQL72. Do not deploy the prep
Lambda. Do not re-request capabilities, KYC, KYB, or ToS.

Freedom Adjustment, Condition One Commercial, and
`checksopsadmin@gmail.com` are **already authorized at Moov**. Re-requesting
capabilities or identity re-opens billed underwriting. This phase wires the
remaining ChecksOps sequences so they **reuse those accounts**.

## What this phase executed

| Sequence | Result |
|---|---|
| GET confirm Freedom / C1C / platform (checksopsadmin) | GET only — no KYC POST |
| Capability family match | `send-funds` satisfies `send-funds.ach`; **never re-POST** |
| Discover/link vs create | Known merchants **409** `known_approved_account_must_be_linked` |
| AWS BANK→WALLET writer | Dark, fail-closed; 1¢ cap; Sweep `$0` min **blocks Test 1** |
| AWS WALLET→RECIPIENT writer | Dark, fail-closed; no bank fallback; **no internal bypass** |
| `initiate-wallet-funding` | Refused (`use_separate_fund_and_disburse`) |
| Sweep PATCH | **Not done** — no chosen retain minimum |
| Money flags / SQL72 / transfers | **Unchanged / not executed** |

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
`support@checksops.com`). The facilitator account itself is already
KYB-verified. Do not create a new account or re-KYC to attach that mailbox.

Platform list (`GET /accounts`, 7 connected accounts) also contains leftover
unverified duplicates (second Freedom `7c50c273-…`, extra individual
accounts, pipeline-test LLC). **Do not KYC or capability-request those.**
AWS writers allowlist only the known approved ids above.

Live prep Lambda CodeSha256
`ZJsY9c2HBHmBLsri4U8Yq0mbUg/j/eupd0YlbBJ1AmM=` (unchanged). Money flags all
**false**. `AWS_PROVIDER_LIVE_READS_ENABLED=true`.

`capabilityFlags` now treats family names as enabling `can_ach_debit` /
`can_ach_credit`. The stale RDS `can_ach_debit=false` snapshot is **not**
authority for the AWS writers — they GET live capabilities.

## Fail-closed AWS writers

Reachable only when **all** of these are `true` (they stay **false** live):

- `AWS_MOOV_ENABLED`
- `AWS_PROVIDER_EXECUTION_ENABLED`
- `AWS_FINANCIAL_PERMISSIONS_ACTIVATED`
- `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED` **false** (ambiguous mode → 409)

Additional holds inside the writer (even if flags were lifted):

1. **No capability / KYC / account-create POST** (`moov_kyc_rerequest_blocked`)
2. First transfer **1 cent** (`first_transfer_cap`)
3. Financial TOTP bound to `wallet.fund` or `wallet.disburse` + tenant +
   amount + payment-method ids (`financial_totp_required`)
4. Enabled Sweep with `minimumBalance <= 0` → `sweep_minimum_blocks_test`
5. WALLET→RECIPIENT refuses `x-checksops-internal` and `source_kind=bank`
6. Persist `payment_transfers` (`environment=production`) **before** HTTP; CAS
   `ready` → `submitting`; unknown/timeout → reconcile, never a second POST
7. Known merchant/recipient allowlist — unknown parties are not created

## Sweep (unchanged live)

Freedom Sweep `2d2c900d-6efb-43a2-ba90-2fd77e22afdd` remains **enabled** with
minimum **`$0.00`**. Test 1 is **blocked in code** until a later reviewed
step pauses it or sets a retain minimum (Moov example is `$150` — **not
guessed here**).

## Holds (unchanged)

Money flags stay false. No wallet fund. No Sweep create/update. No transfer.
No SQL72. No Lambda overlay. No re-KYC.

## GO / NO-GO

**GO** for the no-re-KYC sequences and dark AWS writers.

**NO-GO** to enable money, PATCH Sweep, or run Test 1 1¢ until a human
chooses a Sweep minimum (or pause) and explicitly orders the cent tests.
