# M6.4E.1 — Dark-only integrate of PR #270 bank-verify contract

**STOP FOR REVIEW.** Bank-verify writes stay **false**. No microdeposit. No MV code.
PR #270 was **not** merged as activation. `ChecksOpsCursorCloudStaging` was not broadened.
`checksops-production-prep-api` was not `UpdateStack`'d. Staging API was not deployed.

## Compatibility

PR #270 `index.mjs` would drop the live `/public/moov-recipient-session` route and would
not include later `main` app-services paths. Live prep Lambda already had session + KYC/ToS
+ bank-verify routes from M6.4A–D.2.

Integration therefore **did not** replace live `index.mjs` with PR #270's copy. Git wiring
adds the same public routes onto current `main` without dropping later handlers.

Live overlay copied only these three files onto the existing zip:

- `providers/recipient-bank-verify-state.mjs` (TTL/tenant/CAS; verified `REMOVE #ttl`)
- `providers/recipient-bank-verify-state-probe.mjs` (UpdateItem TTL cleanup; no table-admin)
- `public-moov-recipient-bank-verify.mjs` (public sanitization + tenant stamp)

The DynamoDB table stays the operator-created standalone table
(`aws/production/bank-verify-state-table.yaml`). It is **not** added as a resource on
`aws/production/api-cfn.yaml`.

## Live overlay

| Field | Value |
|---|---|
| Function | `checksops-production-prep-api` |
| CodeSha256 | `Uz5P3HBhbG+793S+v8vuDReL0y/1YQnuiAX4x37ahJg=` |
| LastModified | `2026-09-13T11:02:17.000+0000` |
| Env keys | 32, unchanged vs pre-overlay |
| `AWS_PROVIDER_RECIPIENT_BANK_VERIFY_WRITES_ENABLED` | `false` |
| Money / Moov / CheckAlt / sandbox-execution / financial-permissions | all `false` |
| SPA | **not** redeployed |

Live pay-setup chunk `RecipientPaymentSetup-BwvGV6K0.js` has no Send/Confirm controls.
Copy is “Bank verification is not available yet.” Session `bank_verify_available` is
`providerRecipientBankVerifyWritesEnabled()` (false).

## Proofs (synthetic `PROBE#m64d2#synth-m64e1-b844-b`)

- DescribeTable ACTIVE, exact `pk`/`sk`, PAY_PER_REQUEST, deletion protection enabled
- GetItem / CAS winner claimed / second claimant `claimed: false`
- Claim `ttl=1797073854` (~90 days from `claimed_at`)
- MV limiter 1–3 allow, 4th `max_attempts_exceeded`
- Cross-invocation: still `initiation_claimed`; all MV blocked; TTL now cleanup stamp `1789297914` (~60s)
- Cleanup method `ttl` via UpdateItem `ExpireClaimTtl` / `ExpireMvTtl`; `lambda_table_admin=false`
- Probe source has no `DeleteItem` / `CreateTable`; Lambda IAM is Get/Put/Update/Describe only
- Dark initiate/confirm 403 `recipient_bank_verify_writes_blocked`, `liveProviderCalled=false`
  (direct Lambda invoke + CloudFront `https://checksops.com/prep/...`)
- `provider_http=false`, `microdeposit_initiated=false`, `mv_code_submitted=false`

Verified-state TTL removal (`REMOVE #ttl`) is in the store and unit tests
(`verified.item.ttl === null`). The live prove probe does not transition a claim to `verified`.

Target unchanged (not mutated):

- recipient `62a858ff-ee6a-49d7-9898-1c8e4a44227b`
- account `ee8c608e-dc2d-45d3-95e9-3c992f3dfc5f`
- bank `72eb66c1-d9a9-4f85-ab50-8871db9ceeea` (Chase ••••1506)

## Holds that remain

Do not enable `AWS_PROVIDER_RECIPIENT_BANK_VERIFY_WRITES_ENABLED`.
Do not initiate a microdeposit or submit an MV code.
Do not enable Moov / CheckAlt / provider execution / financial-permissions / sandbox-execution.
Do not apply SQL72. Do not change Cognito/TOTP. Do not move money.
Do not deploy `checksops-staging-api`. Do not `UpdateStack` `checksops-production-prep-api`.
