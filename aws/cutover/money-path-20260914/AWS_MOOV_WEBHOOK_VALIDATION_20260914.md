# AWS Moov webhook validation — 2026-09-14

Operator stored a new production signing secret at
`checksops/production/moov-webhook` for
`https://checksops.com/prep/webhooks/moov`. The existing Lovable/Supabase
webhook was not removed or modified.

## Verdict

**WAITING FOR GENUINE MOOV EVENT**

The AWS receiver can load the dedicated secret, fail-closes invalid traffic,
and is configured for production apply (`dry_run: false`). No genuinely
Moov-signed event has arrived at the new endpoint yet. Do not remove the old
Supabase webhook.

## 1. Secret access via `MOOV_WEBHOOK_SECRET_ARN`

`checksops-production-prep-api` has
`MOOV_WEBHOOK_SECRET_ARN=.../checksops/production/moov-webhook-H1ZFVH`.

Secret metadata (value never printed, hashed, or returned):

- Last changed `2026-09-14T12:15:30.042Z`
- JSON object with nonempty `MOOV_WEBHOOK_SECRET`
- Usable by the current loader

The production execution role could not `GetSecretValue` on the new dedicated
secret until a same-account resource policy was attached (same pattern already
used on `checksops/production/provider`). Policy file:
`aws/production/moov-webhook-secret-resource-policy.json`.

After that grant plus a cache recycle (`CHECKSOPS_SECRET_EPOCH=20260914T123236Z`):

- `GET /prep/ops/money-path-readiness` → `moovWebhookSecretConfigured=true`
- `GET /prep/providers/status` → `MOOV_WEBHOOK_SECRET_configured=true`
- CodeSha256 unchanged: `7Jzn63Xc1TUfQhTtn7Vn+b2oSbvhd53vstqUiVkct7s=`

## 2. Fail-closed

| Probe | Result |
|---|---|
| Unsigned `POST https://checksops.com/prep/webhooks/moov` | `401 missing_signature_headers` |
| Forged HMAC headers | `401 invalid_signature` |
| Unsigned Lovable `.../functions/v1/moov-webhook` | `401 Invalid signature` (untouched) |

## 3. Genuine Moov-signed event

Not observed.

- `aws_provider_webhook_receipts` Moov rows: 7 historical **dry-run** (latest `2026-09-03`). Live since cutover: **0**.
- `payment_webhook_events` since `2026-09-14T12:00Z`: **0**. Latest still `2026-09-13T18:25:18.120Z` `paymentMethod.enabled` (Supabase path).
- APIGW access logs: AWS webhook POSTs in this window are the unsigned/forged probes (`401`). No `200`.

Moov documents a safe Dashboard/API ping (`POST /webhooks/{webhookID}/ping`,
`event.test` / `{ ping: true }`) that does not move funds. OAuth to
`api.moov.io` from this host and from a same-VPC temp Lambda both returned
Cloudflare **1010**. No transfer or CheckAlt deposit was created.

Operator can send **Send test webhook** from the Moov Dashboard to
`https://checksops.com/prep/webhooks/moov` without moving funds. Re-run
validation after that (or after the next real production event).

## 4–6. Apply / dual delivery / no duplicate money

Cannot prove signed apply (`applied: true`, tenant map, event id) until a
Moov-signed POST is accepted. Dual delivery of the **same** event to AWS and
Supabase has not occurred since the new webhook was created. Financial
aggregates and production transfer/ledger/funding tables show **no** new
activity since `12:00Z`. Dual delivery has not created duplicate financial
state.

## 7. Fingerprint / aggregates

Fingerprint file unchanged
`ccb9a1144d46f607f542aa61e765098177eb8a15d318e0a081d6b762ccd021b3`.

Aggregates still match exactly. $9,984.11 check still
`approved_for_deposit` with 0 CheckAlt rows. C1C UAT intake still 37.

## 8. Cognito mappings

All 8 repaired production `cognito_sub` values remain the 10:07 UTC pairs.
`identity_accounts` still 11 rows.

## Untouched

- Existing Lovable webhook URL
- SPA (not deployed)
- Rehearsal oneshot Lambda
- Temp probe Lambdas deleted after use
