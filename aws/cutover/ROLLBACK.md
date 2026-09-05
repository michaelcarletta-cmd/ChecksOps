# Production cutover rollback

**This file is a procedure. Do not execute it from this PR.**  
Dry-run only: `node aws/cutover/scripts/rollback-dry-run.mjs`

Rollback **does not** delete Moov/CheckAlt provider objects, empty S3, drop production Supabase, or remove the Lovable bridges (needed for retry until a successful cutover is declared).

## Point A — before DNS / webhook switch

Production never left Lovable/Supabase.

1. Leave/restore DNS to Lovable/Supabase frontend + API (apex/`www` recorded targets; 2026-09-05: `185.158.133.1`).
2. Do not redirect provider webhooks (they never moved).
3. Lift write-freeze only after Supabase health.
4. Drop failed `checksops_rehearsal_*` only. Never drop production Supabase. Never drop live staging `checksops` unless that was the failed swap target.
5. Leave S3 copies in place (append-only).
6. Disable Cognito users created only for the failed wave (production pool if any were created; never mass-delete staging UAT users).
7. Bridges stay deployed for a later retry.

## Point B — after DNS, flags still OFF

1. Revert apex/`www` DNS to recorded Lovable targets. Do not wait for CloudFront disable.
2. Keep AWS S3/RDS (no destructive rollback).
3. Users sign in on Supabase Auth again (Cognito passkeys unused; production SimpleWebAuthn still in `user_passkeys`).
4. Reconcile any AWS writes during the window (should be near-zero if flags stayed false).
5. Leave webhooks on Supabase if they were never switched; if dual-run subscribers were added, remove **only** the AWS extra subscriber (keep Supabase).

## Point C — after provider flags ON (money risk)

1. Set `AWS_PROVIDER_EXECUTION_ENABLED=false` immediately (Lambda env / console — no full deploy required).
2. Set `AWS_MOOV_ENABLED`, `AWS_CHECKALT_ENABLED`, `AWS_FINANCIAL_PERMISSIONS_ACTIVATED` false.
3. Restore webhook URLs to last known-good Supabase endpoints.
4. Restore DNS to Lovable if the SPA cannot run with flags disabled.
5. Leave ledgers and provider objects intact; do not delete Moov/CheckAlt objects.
6. Reconcile with `POST /financial/reconcile` report-only; do **not** auto-correct amounts.
7. Do not re-apply `64_financial_activation_grants.sql` during rollback.

## Auth-specific rollback

- If DNS is still Lovable: no Cognito production rollback is required.
- If DNS already moved: revert DNS; Supabase Auth remains the credential store for production passkeys/MFA.
- Do not copy staging pool `us-east-1_vPmQ7cL1F` into production as a rollback target.

## What this PR must not do

- Change Cloudflare
- UpdateFunctionCode on `checksops-staging-api` (live overlay may include CheckAlt work from a separate branch)
- Redirect webhooks
- Tear down bridges
