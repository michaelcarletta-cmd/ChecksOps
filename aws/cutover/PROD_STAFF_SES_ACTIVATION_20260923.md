# Production operational activation — 2026-09-23

Staff Checks path and SES send-enablement. Closed components were not reopened.
CheckAlt E14 and Moov flags were not touched.

## Frozen baseline (still live)

| Item | Value |
|---|---|
| Git SHA | `707f4f5092b3ac8cd81b113ae36fbef72250ed39` |
| Lambda | `checksops-production-prep-api` |
| CodeSha256 | `pVwEBVCZJG5PCS6kVmktMiziQ3SxE2NTnncC1pWxHUY=` |
| LastModified | `2026-09-23T12:29:41.000+0000` |
| SPA | `index-BR49bZTp.js` |
| SQL 71 | 3-arg and 4-arg `aws_public_homeowner_ledger_upload_insert` both present |

Money flags unchanged: `AWS_CHECKALT_ENABLED=true`, `AWS_PROVIDER_EXECUTION_ENABLED=true`, `AWS_ENDORSEMENT_AUTO_ADVANCE=false`, `AWS_MOOV_ENABLED=false`.

## Staff acceptance

Production login is Cognito EMAIL_OTP (`/auth/login` returns 410 `password_auth_disabled`).

Connected mailbox for this run: `claims@freedomadj.com`.
Cognito EMAIL_OTP to that mailbox works (From `Support@checksops.com`).
`/prep/identity/me` after verify: mapping active, roles `mortgage_agent` only, tenants `[]`.

Freedom ChecksOps staff identities (existing, not created):

| Email | Role | Mailbox readable here |
|---|---|---|
| `mcarletta@freedomadj.com` | Freedom admin | No |
| `checksops-tester@freedomadj.com` | Freedom operator | No |

`claims@` is not a Freedom tenant member. Adding it would create access; that was not done.
Checks → Review Check → images → claim → descriptive save → endorsement was not reached.

PRODUCTION STAFF CHECK OPERATIONS — COMPLETE: **NO**

Missing prerequisite: operator-provided EMAIL_OTP (or a connected mailbox) for `mcarletta@freedomadj.com` or `checksops-tester@freedomadj.com`.

## SES readiness

Region/account: `us-east-1` / `806168576068`.

Proven:

- Cognito production pool uses SES DEVELOPER From `arn:aws:ses:us-east-1:806168576068:identity/Support@checksops.com`.
- Auth codes to `claims@freedomadj.com` arrive from `Support@checksops.com`.
- Existing handlers already support `AWS_EMAIL_MODE=ses` (`emailMode()` / `sendViaSesOrSink()`).
- Recipient allowlist (existing, not redesigned): domains `checksops.invalid`, `checksops.com`, `freedomadj.com`; exact extras include `mcarletta@freedomadj.com` and `checksops-tester@freedomadj.com`. Unset allowlist env uses those defaults even in SES mode.

Not ready to enable `AWS_EMAIL_MODE=ses` as the only missing step:

1. Production Lambda `AWS_EMAIL_MODE` is unset (sink default). `AWS_EMAIL_FROM` is also unset, so application From would be `ChecksOps Staging <noreply@checksops.com>`.
2. Public DNS has no SES domain verification or DKIM for `checksops.com` or `notify.freedomadj.com`. `checksops.com` SPF is Outlook-only.
3. Freedom `tenant_email_settings`: `sending_domain=notify.freedomadj.com`, `domain_status=verified` (DB flag), `ses_identity_name=null`, `custom_sending_enabled=false`. Intended notify identity is not a live DNS SES identity.
4. Cursor role cannot read SES account production-access/sandbox, identity verification, or the production API execution role policy. Repo production role template omits `ses:SendEmail`.
5. Application `email_send_log` recent rows are older `magiclink` entries with `provider=null`, not AWS SES public-workflow mail.

Exact SES configuration change made: **none**. `AWS_EMAIL_MODE` left unset.

PRODUCTION EMAIL DELIVERY — COMPLETE: **NO**

Missing prerequisites: verified application From that matches a live SES identity; confirmed Lambda `ses:SendEmail`; SES production-access confirmation; then `AWS_EMAIL_MODE=ses` only.

## Regression (no SES env change)

| Check | Result |
|---|---|
| `/prep/health` | 200 `production-prep` ok |
| Cognito EMAIL_OTP | start + verify 200; `/identity/me` 200 |
| Authenticated Freedom staff Checks | not reached (mailbox/role gap) |
| Public Sign missing/invalid | 400 `validate_token` / 404 `fetch_signer` |
| Public Endorse missing/invalid | 400 Token required / 404 token_consumed |
| Public Endorse Brenda read-only | 200 signed check 1070668 |
| Ledger invalid token | 404 `not_found` fail-closed |
| Public branding Freedom logo | 302 → 200 PNG 885435 bytes |

Inspect Lambda `checksops-endorsement-transition-inspect-e3dd` restored to SHA `yYb/cXdUXkVh6JIesDAXwPcLmPwyTy86WwWvf4+xyso=`.
