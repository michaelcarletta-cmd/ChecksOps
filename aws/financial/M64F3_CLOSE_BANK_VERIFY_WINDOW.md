# M6.4F.3 — Close bank-verification activation window

**STOP FOR REVIEW.** Do not enable money execution. Do not initiate or confirm
bank verification. Do not change Cognito/TOTP. Do not apply SQL72.

M6.4F.2 is accepted. Recipient onboarding is complete. This phase sets **only**
live Lambda env `AWS_PROVIDER_RECIPIENT_BANK_VERIFY_WRITES_ENABLED=false`.
CloudFormation templates already had `"false"`. CodeSha256 is unchanged.

## Live env

| Field | Value |
|---|---|
| Function | `checksops-production-prep-api` |
| CodeSha256 | `ZJsY9c2HBHmBLsri4U8Yq0mbUg/j/eupd0YlbBJ1AmM=` (unchanged) |
| LastModified | `2026-09-13T18:34:36.000+0000` |
| Env keys | 32 before, 32 after |
| Keys changed | **only** `AWS_PROVIDER_RECIPIENT_BANK_VERIFY_WRITES_ENABLED` `true` → `false` |
| Moov / execution / financial-permissions / sandbox-execution / CheckAlt | all `false` |

Method: `lambda:UpdateFunctionConfiguration` with existing `RevisionId` and
the full 32-key map. Not CloudFormation. Identity
`ChecksOpsCursorCloudStaging/checksops-t0-run`.

## Read-only after close

GET-only `preflight_target` (`provider_http_write=false`, `dynamo_write=false`):

| Check | Result |
|---|---|
| KYC | `verified` |
| ToS | accepted `2026-09-12T17:37:31.697535Z` |
| Bank | Chase ••••1506, **verified**, same id |
| `/verify` | HTTP 200 `successful` |
| DDB | `verified`, `ttl=null`, same claimant, same claimed_at/updated_at as F.2 |
| Banks on account | 1 |
| `payment_transfers` | 0 |
| Dummy initiate | 403 `recipient_bank_verify_writes_blocked`, `liveProviderCalled=false` |

Session HTTP 200: `complete=true`, `bank_verified=true`,
`bank_verify_available=false`, recipient `ready`, `token_consumed=false`.

## Holds

Do not enable Moov / CheckAlt / provider execution / financial-permissions /
sandbox-execution. Do not re-open bank-verify writes unless a later reviewed
phase requires it. Ready to **design** a controlled Moov transfer phase; not
ready to enable transfer flags here.
