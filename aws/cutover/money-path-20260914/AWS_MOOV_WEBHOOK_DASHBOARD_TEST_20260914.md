# AWS Moov webhook — Dashboard test revalidation — 2026-09-14

## Verdict

**NO GO — AWS MOOV WEBHOOK FAILED**

A Moov Dashboard test POST reached
`https://checksops.com/prep/webhooks/moov` and was rejected. The old
Supabase webhook must stay. SPA was not deployed.

## What arrived

| Field | Value |
|---|---|
| Time | `2026-09-14T12:55:28.910Z` |
| Source | `8.34.212.4` (`*.bc.googleusercontent.com`) |
| Request | `POST /prep/webhooks/moov` |
| APIGW | `401`, `integrationStatus=200` (Lambda ran) |
| Body length | `233` = `invalid_signature` (not `missing_signature_headers` = 241) |
| Lambda errors | 0 |

Signature headers were present (otherwise the handler returns
`missing_signature_headers`). Verification failed. Fail-closed: no row in
`aws_provider_webhook_receipts` or `payment_webhook_events`.

## Required checks

| Check | Result |
|---|---|
| Genuinely Moov-sent event received | HTTP POST yes; **not accepted** |
| Signature validation passed | **No** (`401 invalid_signature`) |
| `dry_run: false` | Flag is false; event never persisted |
| Event ID recorded | **No** |
| `applied: true` if required | **No** (rejected before apply) |
| Tenant/account resolution | Not evaluated |
| No duplicate financial effect | Yes (nothing written) |
| Financial aggregates | Unchanged vs fingerprint |
| Repaired Cognito mappings | Unchanged (8/8) |

Fingerprint SHA256
`ccb9a1144d46f607f542aa61e765098177eb8a15d318e0a081d6b762ccd021b3`.

## Likely cause (secret not printed)

The dedicated secret is configured and nonempty. A matching HMAC was not
produced. Typical operator issues: stored the Lovable/Supabase secret, extra
JSON quotes, or a different webhook’s secret. `timestamp_outside_window` is
also returned as `invalid_signature`.

Do not remove
`https://nbcqwpysqgyxrrbgtmkw.supabase.co/functions/v1/moov-webhook`.
