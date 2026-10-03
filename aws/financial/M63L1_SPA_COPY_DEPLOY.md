# M6.3L.1 — Deploy financial TOTP UI copy/flow

SPA-only. Lambda, Cognito, SQL, and money flags were not changed.

## Return card (2026-09-11T13:13Z)

```
FRONTEND COMMIT: 93edbf3f (cherry-pick of reviewed d079d43a onto main 8dfdebdb).
                 M6.3L copy was NOT on main before this PR.
SPA DEPLOYED: YES — vite build --mode aws → s3://checksops-production-frontend-806168576068
CLOUDFRONT INVALIDATION: I3BYZV36KDYPRMVORQL2L6RBXG /* on E1B0ZWWO5559U5 (create succeeded;
                         GetInvalidation denied on Cursor role)
LIVE BUNDLE: https://checksops.com/assets/index-niYCGC4j.js
             SHA-256 84ed64fc2f4f55174b35afe0824c9990825c771839288298b9ab439a06c63ff3
OLD COPY REMOVED: YES (Authenticator (TOTP), Optional at login, SOFTWARE_TOKEN_MFA absent)
APP FINANCIAL ENROLL ENDPOINT: POST /prep/auth/mfa/associate (associateAwsTotp)
COGNITO ENROLL ENDPOINT REACHABLE FROM BUTTON: NO (AssociateSoftwareToken absent from bundle)
BACKEND CHANGED: NO (Lambda CodeSha256 still iSlY+6TrrGJLPRUj5mOZ7drrAzHlMSpg/haisS02j8E=)
PRODUCTION USER CHANGED: NO
MONEY FLAGS: unchanged (execution false)
SAFE FOR MICHAEL TO CLICK ENROLL: YES (app-level ChecksOps Financial TOTP; login stays EMAIL_OTP)

STOP FOR REVIEW.
```

## What was wrong

`main` at `8dfdebdb` (PR #220 dark merge) still titled the Security card
`Authenticator (TOTP)` / `Optional at login` / `Set up authenticator`.
Reviewed M6.3L copy lived only on PR #222 (`d079d43a`), not merged.

Live apex before deploy: `/assets/index-B-TxXkkm.js` contained the old strings
and `SOFTWARE_TOKEN_MFA`. It already called `/auth/mfa/associate` (app route on
the live Lambda). It did **not** embed `AssociateSoftwareToken`.

## What shipped

Cherry-pick `d079d43a` → `93edbf3f` on this branch. `vite build --mode aws`
with production `.env.aws` (`VITE_CHECKSOPS_API_URL=/prep`, pool
`us-east-1_h00WorYMT`, client `3ja9fqaq2fjkv3i6up2varcqpe`).

S3 sync of `dist/` (no `--delete`). `index.html` cache-control
`no-cache,no-store,must-revalidate`. Hashed assets `immutable`.

Live proof after invalidation create (`x-cache: Miss from cloudfront`):

| String | Live `index-niYCGC4j.js` |
| --- | --- |
| ChecksOps Financial authenticator | present |
| ChecksOps Financial (issuer) | present |
| Confirm with ChecksOps Financial authenticator | present |
| Set up ChecksOps Financial authenticator | present |
| `/auth/mfa/associate` | present |
| Authenticator (TOTP) | absent |
| Optional at login | absent |
| SOFTWARE_TOKEN_MFA | absent |
| AssociateSoftwareToken | absent |
| Cognito financial MFA | absent |
| `kiqojucc02.execute-api` | absent |

`www.checksops.com` points at the same hashed bundle.

Enroll button → `associateAwsTotp` → `POST ${awsApiBaseUrl()}/auth/mfa/associate`
(same-origin `/prep`). Live Lambda maps that to app `financial_totp_enrollments`,
not Cognito `AssociateSoftwareToken`.

## Unchanged

- Lambda CodeSha256 `iSlY+6TrrGJLPRUj5mOZ7drrAzHlMSpg/haisS02j8E=`
- Production user `UserMFASettingList` empty; last modified `2026-09-10T18:56:10.659Z`
- Money flags false

Do not enroll from this agent. Michael completes EMAIL_OTP login, then clicks
**Set up ChecksOps Financial authenticator**.
