# Tranche 4 results

Branch `cursor/aws-provider-tranche-4-c48b`. PR targets `main`. Production ChecksOps, production DNS, production Supabase provider functions, and production webhook URLs were not touched.

Live staging API: `https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging`

## Implementation

- Typed adapters under `aws/functions/api/providers/`
- Kill switches default false; Tranche 4 hard-blocks execution even if flags are true
- Local Moov/CheckAlt/Plaid status reads under RLS
- Webhook verification + idempotent dry-run receipts
- Secrets from `PROVIDER_SECRETS_ARN` / env fallbacks; never returned to the browser
- Frontend AWS `functions.invoke` posts to `/functions/v1/:name`

## Unit tests

`node --test aws/tests/api-providers.test.mjs`: **17/17 PASS**

Existing `api-write` / `api-health` / `api-authorization`: **31/31 PASS** (no regression).

## Live validation

Filled after staging API + Cognito testers + financial aggregates.

## Production

- Production touched: **no**
- Real provider transaction: **no**
- Production webhooks redirected: **no**
