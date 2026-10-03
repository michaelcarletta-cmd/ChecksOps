# E13 CheckAlt production dry-run acceptance

Recorded 2026-09-22. No deposit submitted. Money flags unchanged.

## Production baseline (reconfirmed)

| Item | Live value |
| --- | --- |
| API | `checksops-production-prep-api` / `https://checksops.com/prep` |
| API CodeSha before overlay | `mbIefR79pYELR2uEGUNRazj+XCKiGVb2CBU9Cqr5cD0=` |
| API CodeSha after gated overlay | `COjFgV8sD7NmAe+/4XyXUG1n7r9JDItT1T4PFu9FjTc=` |
| SPA | `index-BwMXtcQm.js` sha256 `26ad3d423b9ee515e47f91cf57a79f543e9dfb3c4d885046d7e4c5bdecb5ffb1` |
| SPA S3 | `checksops-production-frontend-806168576068` AES256; metadata `e12-git=a733d104a26e3817ec44f5d7fd38950eb5427757` |
| Isolated RDS | `checksops-production` postgres MultiAZ `available` |
| Production S3 files | `checksops-production-privatefiles-806168576068` |
| CheckAlt HTTP handlers | authenticate / deposit/process / poll / approve present in production package; execution flags false |
| SQL 65 objects | Columns + `aws_financial_execution_active` + `aws_checkalt_production_config` + financial insert/update policies **already present**. Do not re-apply the file. Application hold snapshot still reports `NOT_APPLIED` as a code constant. |
| Tenant mapping | Freedom `2eff5f1a-929d-4ce3-9a8b-cd96b98df42a`: enabled, SSO + deposit account present. C1C: **not mapped**. |
| Historical `checkalt_deposits` | 69 rows (58 referenced), amount sum `453990.48`, statuses 53 submitted / 11 error / 5 rejected, last_updated `2026-09-04T15:58:10.843Z` **unchanged after dry-run** |
| Historical `checkalt_webhook_events` | 2 rows intact |

## Guardrails (held)

`AWS_PROVIDER_EXECUTION_ENABLED=false`  
`AWS_CHECKALT_ENABLED=false`  
`AWS_FINANCIAL_PERMISSIONS_ACTIVATED=false`  
`AWS_PROVIDER_WEBHOOK_DRY_RUN=true`  
`AWS_MOOV_ENABLED=false`  
`AWS_MOOV_TRANSFER_POST_ENABLED=false`  
`AWS_CHECKALT_STATUS_RECONCILE_ENABLED=false`  
`AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED=false`

## Webhook secret

- Added production-only `CHECKALT_WEBHOOK_SECRET` to live `PROVIDER_SECRETS_ARN` (`checksops/production/provider`).
- New random value. Staging secret was not readable from this role; the generated value was not copied from UAT/sandbox names.
- `GET /providers/status` now reports `CHECKALT_WEBHOOK_SECRET_configured=true` and does not return the value.
- Lambda env `AWS_CHECKALT_WEBHOOK_SECRET` remains unset (Secrets Manager only).

## Webhook endpoint

`https://checksops.com/prep/webhooks/checkalt`

CheckAlt production dashboard was **not** configured from this agent (no authorized CheckAlt console access). Operator must enter that URL and the production HMAC secret. See `CHECKALT_FIRST_DEPOSIT_RUNBOOK.md`.

## Live dry-run proof (2026-09-22T21:27Z)

| Case | Result |
| --- | --- |
| Unsigned POST | `401 missing_signature_headers` |
| Malformed JSON | `400 malformed_webhook` |
| Bad HMAC | `401 invalid_signature` |
| Valid signed event | `200` `dry_run=true` `applied=false` `apply_skipped=webhook_dry_run` `productionRecordsMutated=false` `liveProviderCalled=false` |
| Same event replay | `200` `duplicate=true` `apply_skipped=duplicate` same receipt id |
| Tenant correlation | lookup `checkalt_deposit`; `mapped_tenant_id` = Freedom; payload `tenant_id` = `[ignored-untrusted]` |
| Receipt | 1 row, `dry_run=true`, `provider=checkalt` |
| Deposit mutation | `checkalt_deposits` count 69 / amount `453990.48` / last_updated still `2026-09-04T15:58:10.843Z` |

## Apply-gap prep

Deployed, gated off. When `AWS_PROVIDER_WEBHOOK_DRY_RUN` is later set to `false` **and** sandbox execution stays false, a signed unique CheckAlt event can UPDATE the looked-up `checkalt_deposits` row (status / last_status_payload / cleared_at / returned_at only). RLS `FORCE` is off; `checksops` already has UPDATE. If FORCE RLS is later enabled, add a webhook-apply policy before disabling dry-run.

Unit tests: `aws/tests/checkalt-production-webhook.test.mjs` plus existing provider tests — 32 pass.

## Reconciliation

`AWS_CHECKALT_STATUS_RECONCILE_ENABLED` stays **false**. The job performs live CheckAlt HTTP and `persistPollOutcome` on existing `checkalt_deposits` rows. It is suitable as a later backup after the first deposit has a reference, not before the first deposit.

## First money-execution point (later)

The first successful production `POST /public/fincapture/deposit/process` from `checkalt-submit-deposit` after the runbook flag sequence. Not this phase.
