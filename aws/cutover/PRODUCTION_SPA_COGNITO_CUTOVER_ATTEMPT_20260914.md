# Production SPA → Cognito cutover attempt — 2026-09-14 — STOP FOR REVIEW

**Verdict: NO-GO. Backend not ready. No SPA build was deployed. Production untouched.**

This is a re-attempt of the same slice already validated once in
`API_PERIMETER_STEP2_PASS.md` (2026-09-08): switch the production SPA from
Supabase to Cognito + same-origin `/prep`, with all provider/financial
execution flags left exactly as configured (not touched by this task).

## Pre-cutover state of record

| Item | Value |
|---|---|
| `origin/main` SHA at investigation start | `faf9b82e728bd7ef42009e4c96ace05c7bd7232f` |
| Live SPA bundle | `assets/index-ByTwb1fQ.js` (Supabase-only) |
| Live `index.html` S3 version (latest) | `HA5fp2Oqg0FYy0xQg5YZzCDdNSG34kFS`, 2026-09-13T11:47:46Z |
| CloudFront distribution | `E1B0ZWWO5559U5` (`dmgs35lzv89ms.cloudfront.net`), aliases `checksops.com` + `www.checksops.com` |
| S3 origin (SPA) | `checksops-production-frontend-806168576068` |
| API origin (`/prep`, `/prep/*`) | `ProductionPrepHttpApi` → `kiqojucc02.execute-api.us-east-1.amazonaws.com` |
| Lambda | `checksops-production-prep-api`, last modified `2026-09-14T02:38:07Z` |
| Cognito pool | `us-east-1_h00WorYMT` ("checksops-production"), 8 users, deletion protection ACTIVE |
| Cognito app client | `3ja9fqaq2fjkv3i6up2varcqpe` ("checksops-production-web") |
| DNS | Apex + `www` already resolve through CloudFront (confirmed live via public DoH; `CUTOVER_READINESS_MATRIX.md`'s "DNS still Lovable" note is stale) |

## What changed since the 2026-09-08 Step 2 PASS

S3 version history for `index.html` shows a Cognito build (`index-reP2FWHf.js`,
documented in `API_PERIMETER_STEP2_PASS.md`) went live on 2026-09-08T15:31Z,
then was **silently superseded** by at least 9 subsequent routine production
SPA deploys (2026-09-08 through 2026-09-13), each apparently built with the
default `.env.production` (Supabase-only) rather than the private AWS
override. There is no evidence of a deliberate rollback decision — this looks
like an artifact of multiple unrelated feature PRs each redeploying the SPA
with the repo default. **Any future cutover needs a way to keep this from
reverting on the next unrelated production SPA deploy** (see Recommendation).

## Blocking finding: Cognito identity linking is broken for the standard T0 test accounts

Re-ran the same authenticated smoke test used for Step 2 PASS
(`aws/cutover/scripts/t0-app-smoke.mjs`, adjusted to call the CloudFront host
`https://checksops.com/prep` instead of the raw execute-api URL, because a
now-enforced `x-checksops-origin-verify` origin check on the raw execute-api
endpoint returns `403` for direct callers — CloudFront perimeter hardening
landed since Step 2).

Cognito authentication succeeded for both T0 lifecycle accounts (Tester,
C1C admin) via `admin-set-user-password` + `USER_PASSWORD_AUTH`. Every
authenticated call after that (`/identity/me`, `/identity/session`,
`/data/query`, `/financial/*`, `/ops/readiness`, `/providers/*/status`)
returned:

```json
{"ok": false, "statusCode": 401, "error": "identity_not_linked"}
```

`aws/functions/api/identity.mjs` (`resolveIdentitySession`) returns this
exact error when the authenticated Cognito `sub` has no matching row in
`identity_accounts`. This matches the mechanism documented in PR #217
("Phase 3B.14P1: production Cognito identity link repair", still open): a
Cognito user-pool sub churned for at least one production account, and only
that one account (`mcarletta@freedomadj.com`) has been manually repaired so
far. The two standard T0 accounts (Tester, C1C admin) were not part of that
repair and remain unlinked as of this run.

**Consequence if the SPA were cut over today:** users would authenticate
successfully through Cognito and then see every dashboard/data/workflow call
fail with `identity_not_linked`. This is exactly the "partially functional
Cognito SPA" the task requires not shipping.

## Other readiness notes (secondary to the blocker above)

- `AWS_CHECKALT_ENABLED=false` on production — CheckAlt has no working status
  path via AWS yet (`checkAltHandledSeparately` by design; not itself
  cutover-blocking for auth/data, but means "CheckAlt read/status" cannot be
  proven end-to-end post-cutover until that track lands).
- `AWS_PROVIDER_EXECUTION_ENABLED`, `AWS_MOOV_ENABLED`,
  `AWS_PROVIDER_LIVE_READS_ENABLED`, `AWS_FINANCIAL_PERMISSIONS_ACTIVATED` are
  now `true` on the production Lambda (they were `false` at Step 2 PASS).
  This is the parallel Moov M6.x/M7.x readiness track's doing, not this task's.
  Every entry under `GET /prep/providers/status` → `permissions` still reports
  `"activated": false` (a separate `has_permission(...)` grant layer), so no
  real money movement is reachable through ordinary authenticated calls today.
  This task did not change, and does not recommend changing, any of these
  flags.
- Webhooks (Moov, CheckAlt) and the DB/storage migration bridges still point
  at Supabase; a frontend-only cutover does not change that
  (`WEBHOOK_TRANSITION.md`, `BRIDGE.md`).
- A hardcoded UI string in `CheckOpsLogin.tsx`, `MortgageOpsLogin.tsx`,
  `WhiteLabelLogin.tsx`, and `PasskeyManagerCard.tsx` tells users to use
  `https://staging.checksops.com` when native passkeys are unavailable on the
  current origin. This is cosmetic (the actual RP-ID/origin gate correctly
  resolves to `checksops.com` from `VITE_APP_URL` at build time), but would
  confuse a production user who hits that specific error path. Not fixed here
  — out of scope for the smallest cutover candidate and not owned by this task.

## Preflight build proof (local only, not deployed)

Built `dist/` with `vite build --mode aws` and a private, gitignored
`.env.aws` matching `.env.production.aws.example` exactly
(`VITE_AUTH_PROVIDER=cognito`, `VITE_APP_URL=https://checksops.com`,
`VITE_CHECKSOPS_API_URL=/prep`, `VITE_AWS_REGION=us-east-1`,
`VITE_COGNITO_USER_POOL_ID=us-east-1_h00WorYMT`,
`VITE_COGNITO_USER_POOL_CLIENT_ID=3ja9fqaq2fjkv3i6up2varcqpe`). Result:

- Main bundle: `assets/index-BeFpW852.js`.
- `kiqojucc02.execute-api` / raw execute-api hostname: **absent** from the
  entire `dist/` output.
- Staging Cognito pool (`us-east-1_vPmQ7cL1F`) / staging client
  (`71bb7a192cbl6o6s8m259tl589`): **absent**.
- `nbcqwpysqgyxrrbgtmkw.supabase.co` literal: present twice (top-level
  `const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL` in
  `integrations/supabase/client.ts`, never called because
  `isAwsStaging()` short-circuits the ternary to the AWS branch — dead
  reference, not a live call path, matches the documented "KEEP" fallback).
- `aws/tests/*.test.mjs`: 713 passed / 5 failed / 3 skipped. All 5 failures
  are the "disposable PostgreSQL ..." integration tests that require a local
  throwaway Postgres not available in this sandbox — pre-existing and
  unrelated to this change (no backend file was modified by this task).
- No deploy was performed: `.env.aws` was not committed and `dist/` was not
  synced to S3.

## Recommendation

1. Track identity-link repair for **all** production accounts (not just the
   one PR #217 fixed) to completion before attempting this cutover again —
   this is the actual gating item, and it is already someone else's
   in-flight workstream (PR #217 and whatever produced the sub churn in the
   first place). Re-run `aws/cutover/scripts/t0-app-smoke.mjs` (pointed at
   `https://checksops.com/prep`, not the raw execute-api host) after that
   repair; it should return `identity_not_linked: false` for both T0
   accounts before the SPA is switched.
2. Decide how to keep a future SPA cutover from being silently reverted by
   the next unrelated production deploy (multiple happened per day in the
   week before this attempt). Either bake the AWS override into a durable,
   reviewed deploy step, or add a pre-deploy guard that fails a production
   sync if it would replace an AWS-mode bundle with a Supabase-mode one
   without explicit confirmation.
3. Fix the four hardcoded `staging.checksops.com` UI strings before this
   cutover ships, so a production user's error/help text doesn't tell them
   to go to a host they can't reach.

No production resource was modified by this investigation beyond the two
`AdminSetUserPassword` calls on the pre-existing T0 lifecycle accounts
(`checksops-tester@freedomadj.com`, `payments@condition1commercial.com`),
matching the same mechanism and same accounts already used and documented in
`API_PERIMETER_STEP2_PASS.md`. No pool, client, DNS, webhook, provider flag,
or financial-activation change was made.
