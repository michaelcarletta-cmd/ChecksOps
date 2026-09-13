# M6.4F — Enable only bank-verify writes for one human initiation

**STOP FOR REVIEW.** Do not click Send. Do not initiate a microdeposit. Do not
submit an MV code. Do not enable transfers/disbursements. Do not apply SQL72.
Do not change Cognito/TOTP. Do not `UpdateStack` `checksops-production-prep-api`.

This phase sets **only** live Lambda env
`AWS_PROVIDER_RECIPIENT_BANK_VERIFY_WRITES_ENABLED=true` on
`checksops-production-prep-api`. CloudFormation / SAM templates remain `"false"`
so a later `UpdateStack` would revert the live flag. CodeSha256 is unchanged.

## Live env

| Field | Value |
|---|---|
| Function | `checksops-production-prep-api` |
| CodeSha256 | `WsR7gYZPO+emNtQyGDi3gkY4FCPletVbfpbZOXvsJ6g=` (unchanged) |
| LastModified | `2026-09-13T17:29:21.000+0000` |
| Env keys | 32 before, 32 after |
| Keys changed | **only** `AWS_PROVIDER_RECIPIENT_BANK_VERIFY_WRITES_ENABLED` `false` → `true` |
| `AWS_MOOV_ENABLED` | `false` |
| `AWS_PROVIDER_EXECUTION_ENABLED` | `false` |
| `AWS_FINANCIAL_PERMISSIONS_ACTIVATED` | `false` |
| `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED` | `false` |
| `AWS_CHECKALT_ENABLED` | `false` |
| `AWS_PROVIDER_LIVE_READS_ENABLED` | `true` (unchanged) |
| `AWS_PROVIDER_RECIPIENT_KYC_TOS_WRITES_ENABLED` | `true` (pre-existing; unchanged) |

Identity: `ChecksOpsCursorCloudStaging/checksops-t0-run`. Method:
`lambda:UpdateFunctionConfiguration` with the existing `RevisionId` and the
full 32-key map. Not CloudFormation.

## Target (not mutated)

- recipient `62a858ff-ee6a-49d7-9898-1c8e4a44227b`
- account `ee8c608e-dc2d-45d3-95e9-3c992f3dfc5f`
- bank `72eb66c1-d9a9-4f85-ab50-8871db9ceeea` (JPMORGAN CHASE BANK, NA ••••1506)

GET-only `preflight_target` after the flag flip:

| Check | Result |
|---|---|
| KYC | `verified` |
| ToS | accepted `2026-09-12T17:37:31.697535Z` |
| Live bank status | `new` |
| verification_status | `not_started` (`/verify` HTTP 404) |
| should_initiate | `true` |
| initiated | `false` |
| Real-target DDB claim | `exists: false` |
| `provider_http_write` / `dynamo_write` | false |
| `microdeposit_initiated` / `mv_code_submitted` | false |

Probe `ok` is `false` after enablement because that report requires writes
**false**. The GET fields above still succeeded.

## Session (token sha12 `9acf164e4c0a`, not printed, not consumed)

`POST /prep/public/moov-recipient-session` HTTP 200:

- `bank_verify_available: true`
- `bank_should_initiate: true`
- `bank_micro_deposits_initiated: false`
- `token_consumed: false`
- same recipient / account / Chase ••••1506

## Blast radius (flag true, money flags still false)

- Public initiate with `create_transfer`/`ach`/`rtp`/`wire`: **403**
  `provider_execution_blocked`, `liveProviderCalled=false`
- Dummy initiate/confirm (64 `a`): **404** `This link is not valid.`,
  `liveProviderCalled=false` (flag check now passes; token resolve fails closed)
- `/functions/v1` CheckAlt deposit / Moov disburse / wallet / transfer-create:
  fail closed (`tenant-email-domain-handlers.mjs` missing in historical zip)
- GET `/financial/status`: bank-verify **true**; Moov / execution / CheckAlt /
  sandbox-execution / financial-permissions **false**;
  `liveProviderTransactions=false`

## SPA

Live chunk still `RecipientPaymentSetup-Bizl4i1o.js`. Send renders when
session `bank_verify_available === true` and `bank_should_initiate`. Browser
proof on the real pay-setup link: **Send verification deposit** is visible next
to Chase ••••1506; session POST `/prep/public/moov-recipient-session` is 200;
the button was **not** clicked. After that page load, GET-only preflight still
shows bank `new`, verification `not_started`, and no real-target DDB claim.

## Holds that remain

Do not click Send in this phase.
Do not initiate a microdeposit or submit an MV code.
Do not enable Moov / CheckAlt / provider execution / financial-permissions /
sandbox-execution.
Do not apply SQL72. Do not change Cognito/TOTP. Do not move money.
Do not `UpdateStack` `checksops-production-prep-api`.
Templates keep `AWS_PROVIDER_RECIPIENT_BANK_VERIFY_WRITES_ENABLED: "false"`.
