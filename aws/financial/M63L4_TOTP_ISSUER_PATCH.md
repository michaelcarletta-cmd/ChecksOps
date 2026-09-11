# M6.3L.4 — Apple-compatible financial TOTP issuer patch

Deployed. otpauth issuer only. Cognito, wrap key, SQL, Moov, and money flags
were not changed. Production user was not enrolled by this agent.

## Return card (2026-09-11T14:11Z)

```
ISSUER PATCHED: YES
NEW ISSUER: ChecksOps-Financial
UI COPY: ChecksOps Financial authenticator
LAMBDA DEPLOYED: YES — overlay financial-totp.mjs only onto checksops-production-prep-api
SPA DEPLOYED: YES — vite build --mode aws → s3://checksops-production-frontend-806168576068
                 invalidation I7P5SHDOJUG00K87Q19NLV0HQJ
TESTS: relevant 56/56 pass; full aws-api 636 pass / 0 fail / 3 skipped
COGNITO CHANGED: NO (UserMFASettingList empty; PreferredMfaSetting null;
                 UserLastModifiedDate 2026-09-10T18:56:10.659Z)
EXISTING ENROLLMENT CHANGED: NO (associate/verify not invoked; unverified
                 production row remains until Set up once)
MONEY FLAGS: AWS_MOOV_ENABLED=false
             AWS_PROVIDER_EXECUTION_ENABLED=false
             AWS_FINANCIAL_PERMISSIONS_ACTIVATED=false
             AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED=false
SAFE FOR MICHAEL TO CLICK SET UP ONCE: YES
GO/NO-GO: GO for Michael to click Set up once after this review.
          NO-GO for money flags, Cognito, wrap key, SQL, auto-enroll.

STOP FOR REVIEW.
```

## What shipped

`FINANCIAL_TOTP_ISSUER` is now `ChecksOps-Financial` (no whitespace, so no
`%20` in the otpauth path or `issuer=` query). SHA1 / 6 digits / 30s /
`randomBytes(20)` Base32 secret generation / QR library settings are unchanged.

SPA fallback `src/lib/totpQr.ts` uses the same issuer. Live UI copy stays
**ChecksOps Financial authenticator** (L.1 cherry-pick plus this issuer patch).

| | Before | After |
| --- | --- | --- |
| Lambda CodeSha256 | `iSlY+6TrrGJLPRUj5mOZ7drrAzHlMSpg/haisS02j8E=` | `l9nHBQHn+cwwroKO9+czOXi2WMjoeChOpgVFtR0Tj7A=` |
| `financial-totp.mjs` SHA-256 | `763c9f93…` | `3aefafde…` |
| `auth-cognito.mjs` SHA-256 | `d3c8178f…` (M6.3G SELECT_CHALLENGE) | unchanged |
| Live bundle | `/assets/index-niYCGC4j.js` | `/assets/index-cU7wOTrI.js` |
| Bundle SHA-256 | `84ed64fc…` | `332d5097…` |

Redacted synthetic otpauth (RFC 6238 sample key, not a production secret):

```
otpauth://totp/ChecksOps-Financial:synthetic-user%40example.com?secret=REDACTED&issuer=ChecksOps-Financial&digits=6&period=30
```

Query order remains `secret`, `issuer`, `digits`, `period`. `algorithm=` omitted
(SHA1 default). Same as the working `ChecksOps` QR besides the issuer token.

## Human next step

Michael completes EMAIL_OTP login, then clicks **Set up ChecksOps Financial
authenticator** once. That overwrites the existing unverified enrollment and
shows a QR whose issuer is `ChecksOps-Financial`.

Do not enable money. Do not change Cognito MFA. Do not auto-enroll.
