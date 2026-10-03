# Phase 3A — production SPA step-up deploy plan

**Do not lift financial/provider flags.**
**This is a SPA-only plan. Do not create `checksops/production/providers`.**

## Current source vs production

`#175` added Cognito TOTP / dual-control **API helpers** in `src/lib/awsMfa.ts`:

- `stepUpAwsTotp` can send `check_intake_item_id`
- `recordCheckAltDualControl` posts `/financial/checkalt-dual-control`

Production CheckAlt TOTP **requires** that check id. `aws/functions/api/auth-mfa.mjs` rejects step-up without `check_intake_item_id` and binds amount from the server check row.

The live production SPA was **not** rebuilt in Phase 2.7. Even current `main` is incomplete:

- `useFinancialGuard` / `useStepUp` do not accept a check id
- `StepUpDialog` does not pass `checkId` into `stepUpAwsTotp`
- `recordCheckAltDualControl` is unused
- Command Center / Deposit Ops still call `guardFinancial("deposit.submit")` without a check id

A SPA-only deploy of current `main` therefore does **not** satisfy check+amount binding.

## Required SPA wiring before deploy

1. Extend `StepUpRequest` with `checkId?: string | null`.
2. Pass `checkId` from `useFinancialGuard(tenantId)` → `guardFinancial(actionKey, description, checkId)`.
3. Pass `checkId` from `StepUpDialog` into `stepUpAwsTotp` / enroll verify.
4. Call `recordCheckAltDualControl(checkId)` from the CheckAlt deposit UI for the second Freedom owner/admin/manager.
5. Keep session-level TOTP cache from authorizing a **different** check (clear or key the verified flag by check+amount).

## SPA-only deploy sequence (after wiring + review)

1. `npm run build:aws`
2. Sync the `dist/` bundle to the production CloudFront SPA origin only
3. Invalidate CloudFront SPA paths (`/`, `/index.html`, `/assets/*`)
4. Do **not** change Lambda env, WAF, origin-verify, or financial flags
5. Confirm live `index-*.js` contains `checkalt-dual-control` and `check_intake_item_id` on `/auth/mfa/step-up`
6. Confirm `/prep` remains the API prefix and execute-api stays 403

## Out of scope

- Enabling `AWS_CHECKALT_ENABLED` / `AWS_PROVIDER_EXECUTION_ENABLED` / `AWS_FINANCIAL_PERMISSIONS_ACTIVATED`
- Turning webhook dry-run off
- Applying SQL 65
- Creating the production provider secret
