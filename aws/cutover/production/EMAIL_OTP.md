# EMAIL_OTP readiness

| Surface | Status |
|---|---|
| Staging passwordless start/verify | **GO** — `USER_AUTH` + `EMAIL_OTP` |
| Password accepted on passwordless routes | **false** (enforced) |
| Production SPA auth | still Supabase — **not switched** |
| Production Cognito SES From | prepared in this directory, **not deployed** |
| Tester intercept | staging only |

Frontend already uses `verifyAwsEmailOtp` / `startAwsEmailOtp` when `VITE_AUTH_PROVIDER=cognito`.

Remaining for production: create the production pool, attach SES, import the eight mapped users, then (later, separate approval) point the production SPA at that pool.
