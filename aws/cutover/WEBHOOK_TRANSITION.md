# Production webhook transition (plan only)

**Do not redirect production Moov or CheckAlt webhooks from this PR.**  
Plaid webhooks are **N/A**.

## Current state

| Item | Production | AWS |
|---|---|---|
| Moov webhook URL | Lovable/Supabase Edge Function | `/webhooks/moov` deployed; `AWS_PROVIDER_WEBHOOK_DRY_RUN=true` |
| CheckAlt webhook URL | Lovable/Supabase | `/webhooks/checkalt` deployed; dry-run |
| Apply to production ledgers | Live on Supabase | Sandbox apply isolated; production rows refused |
| Dual-run | Not started | Not started |

Moov sandbox signed webhook + replay + bad signature were **PASS** on staging (PR #124). That is not a production URL change.

## Ordered transition (future cutover night — T5 then later)

1. Production URLs **remain** on Supabase.
2. Create an **additional** Moov (and CheckAlt if in scope) subscriber pointing at the **production** AWS HTTPS API (not the staging API host).
3. Keep `AWS_PROVIDER_WEBHOOK_DRY_RUN=true` so receipts are stored and `applied=false`.
4. Prove: valid signature accepted; bad signature 401; expired timestamp 401; duplicate `event id` does not mutate twice; tenant mapping from **provider account id** (payload `tenant_id` ignored).
5. Dual-run clean window recorded (hours/days).
6. DNS cut (T6) happens **without** removing Supabase webhook URLs.
7. After post-DNS recon PASS **and** separate T7 approval: set dry-run false, then remove Supabase URLs.
8. Never flip DNS and webhook ownership in the same step.

## Rollback

- Dual-run only: delete the extra AWS subscriber; keep Supabase.
- After AWS became primary: restore last known-good Supabase URLs, then set AWS dry-run true / execution flags false (`ROLLBACK.md` point C).

## Secrets

Staging webhook HMAC values stay on staging Lambda. Production secrets are a **separate** Secrets Manager object. Do not copy staging secrets into production.
