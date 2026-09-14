# Supabase retirement scope (inventory only — project stays up)

**Date:** 2026-09-14  
**Rule:** Supabase is not being preserved long-term. Do **not** shut down or delete the project in this phase.

Live production browser (`VITE_AUTH_PROVIDER=cognito`, `index-CiOVNYWh.js`) uses `createAwsStagingClient()` → `/prep`. Compiled public JS has **zero** `supabase.co` hosts.

## Classification key

- **ACTIVE_REQUIRED — MIGRATE TO AWS** — still needed for the live product
- **TEMPORARY_ROLLBACK/RECONCILIATION — RETIRE LATER** — keep until rollback/copy tools are done
- **LEGACY_UNUSED — REMOVE** — dead; do not migrate

## Auth

| Dependency | Class | Notes |
|---|---|---|
| Browser Supabase Auth on production-aws | LEGACY_UNUSED — REMOVE | Cognito is live. `.env.production` still has Supabase keys for the *wrong* Vite mode |
| Cognito ↔ `identity_accounts` mappings | ACTIVE_REQUIRED — MIGRATE TO AWS | Already on AWS; do not modify the 8 locked mappings |
| Ninth UUID `dd24eea5-…` `cognito_sub` NULL | ACTIVE_REQUIRED — MIGRATE TO AWS | Pending; not this FA admin path |
| `supabase/functions/auth-email-hook` | LEGACY_UNUSED — REMOVE | Cognito owns email |

## Database / REST / RPC

| Dependency | Class | Notes |
|---|---|---|
| Hosted Supabase Postgres (old DB) | TEMPORARY_ROLLBACK/RECONCILIATION — RETIRE LATER | Not the production write path. RDS is live |
| PostgREST / `supabase-js` `.from()` in SPA | ACTIVE_REQUIRED — MIGRATE TO AWS | Adapter already rewrites to `/prep/data/query` + `/prep/data/write` when Cognito |
| SAFE_WRITE_RPCS / review decision RPCs | ACTIVE_REQUIRED — MIGRATE TO AWS | Already AWS-backed for allowlisted names |
| Generated `src/integrations/supabase/types.ts` | TEMPORARY_ROLLBACK/RECONCILIATION — RETIRE LATER | Schema types still used by the adapter |

## Storage

| Dependency | Class | Notes |
|---|---|---|
| Browser Storage adapter | ACTIVE_REQUIRED — MIGRATE TO AWS | `/prep/storage/*` → S3 |
| `aws/storage/copy-from-supabase.mjs` | TEMPORARY_ROLLBACK/RECONCILIATION — RETIRE LATER | Operator copy tool |
| `aws-staging-storage-bridge` Edge Function | TEMPORARY_ROLLBACK/RECONCILIATION — RETIRE LATER | |

## Edge Functions

| Dependency | Class | Notes |
|---|---|---|
| Class A names already in `app-services.mjs` / provider catalog | ACTIVE_REQUIRED — MIGRATE TO AWS | Live path is Lambda, not hosted Edge |
| `handle-email-unsubscribe` / `moov-account-file-upload` **SPA URLs** | ACTIVE_REQUIRED — MIGRATE TO AWS | Source repaired this phase; live locked SPA still hits origin `/functions/v1/...` |
| Stripe / Telnyx / Zapier Edge functions | LEGACY_UNUSED — REMOVE | Not Class A; fail-closed on AWS |
| QuickBooks Edge functions | LEGACY_UNUSED — REMOVE | Fail-closed; out of this product decision set |
| 100+ leftover `supabase/functions/*` not on Class A / provider catalog | LEGACY_UNUSED — REMOVE **or** already ported | Do not delete the project; treat leftover source as retire-with-project |

## Realtime

| Dependency | Class | Notes |
|---|---|---|
| Supabase Realtime channel | LEGACY_UNUSED — REMOVE | AWS client is a noop; `useAwsPollingFallback.ts` is the live path |

## pg_cron / scheduled jobs

| Dependency | Class | Notes |
|---|---|---|
| Hosted `process-email-queue`, `check-ocr-backlog`, domain recheck, partner push | TEMPORARY_ROLLBACK/RECONCILIATION — RETIRE LATER | Runs on **old** DB only. Does not process AWS RDS writes. Production Lambda has **no** `AWS_SCHEDULED_JOB_SECRET` |
| EventBridge Class A cron on production | ACTIVE_REQUIRED — MIGRATE TO AWS | Not wired yet (secret absent). Interactive OCR/email still work via `/prep` |

## URLs / env

| Dependency | Class | Notes |
|---|---|---|
| `VITE_SUPABASE_URL` on production-aws | LEGACY_UNUSED — REMOVE | Blanked in that Vite mode; leftover concatenations were the X-020 / A5-305 bugs |
| `.env.production` Supabase URL/key | TEMPORARY_ROLLBACK/RECONCILIATION — RETIRE LATER | Wrong mode; guarded deploy uses `.env.production-aws` |
| Hardcoded `PRODUCTION_SUPABASE_URL` in `publicWorkflowApi.ts` | LEGACY_UNUSED — REMOVE | Removed so production-aws artifacts pass the `supabase_host` guard. Cognito uses `/prep/public/*`. |

## Webhooks / bridges

| Dependency | Class | Notes |
|---|---|---|
| Disabled Moov hook `kvwhhewoyjgpjalbtrygzu2geu_whook` → supabase.co | TEMPORARY_ROLLBACK/RECONCILIATION — RETIRE LATER | **Leave disabled.** Do not re-enable |
| Live Moov hook `jwjuxiowcjachnon3i37osimti_whook` → `/prep/webhooks/moov` | ACTIVE_REQUIRED — MIGRATE TO AWS | Already AWS |
| `aws-staging-db-bridge` | TEMPORARY_ROLLBACK/RECONCILIATION — RETIRE LATER | |
| Identity / freeze-drill scripts that call the bridge | TEMPORARY_ROLLBACK/RECONCILIATION — RETIRE LATER | |

## Do not do in this phase

- Delete the Supabase project
- Disable Resend
- Re-enable the Supabase Moov webhook
- Drop RDS columns that originated on Supabase
- Broaden into SES
