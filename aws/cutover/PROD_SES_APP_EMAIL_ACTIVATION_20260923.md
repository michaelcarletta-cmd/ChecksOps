# Production SES application email activation — 2026-09-23

Activation of the existing `emailMode()` / `sendViaSesOrSink()` path. Frozen
CLOSED components were not reopened. CheckAlt E14 and Moov were not touched.
Staff Check Operations remain frozen.

## A. SES production account status

us-east-1 / `806168576068`.

| Item | Value |
|---|---|
| Production access | **enabled** (`ProductionAccessEnabled=true`) |
| Sandbox | **no** |
| Enforcement | `HEALTHY` |
| Sending | enabled |
| Mail type | `TRANSACTIONAL` |
| Review | `GRANTED` |
| 24h quota | 50,000 |
| Send rate | 14/sec |
| Sent last 24h (at inspect) | 27 |

## B. Verified production identities

| Identity | Type | Sending | Notes |
|---|---|---|---|
| `checksops.com` | domain | yes | DKIM success |
| `Support@checksops.com` | email | yes | Cognito DEVELOPER From |
| `ses-gate.staging.checksops.com` | domain | yes | staging only; unused |
| `www.checksops.com` | domain | no | verification failed |
| `noreply@checksops.com` | — | — | no email identity (domain covers it) |
| `notify.freedomadj.com` | — | — | does not exist; not activated |

## C. Selected application From identity

`ChecksOps <support@checksops.com>` via the verified `checksops.com` domain.

Freedom custom-domain sending stays off (`custom_sending_enabled=false`).
Resolved branded From for Freedom is `Freedom Adjustment via ChecksOps <support@checksops.com>`.
`ChecksOps Staging` is not used.

## D. Lambda SES IAM status (before)

Role `checksops-production-api-execution`. Inline policies were OCR, least-privilege, and recipient-bank-verify only. `ses:SendEmail` simulated **implicitDeny**. Implementation uses `SendEmailCommand` only; `ses:SendRawEmail` is not required.

## E. Exact IAM change

Added inline policy `ProductionApiSesSend` on `checksops-production-api-execution`:

- Action: `ses:SendEmail` only
- Resources: `identity/checksops.com` and `identity/Support@checksops.com`

Simulate after: `ses:SendEmail` **allowed**; `ses:SendRawEmail` still denied.
Repo record: `aws/production/api-execution-role.yaml`. Execution role was not replaced.

## F. Exact environment change

`checksops-production-prep-api` configuration only. Code SHA unchanged
`pVwEBVCZJG5PCS6kVmktMiziQ3SxE2NTnncC1pWxHUY=`. LastModified `2026-09-23T15:30:51.000+0000`.

Added (3 keys, 0 removed):

| Key | Value |
|---|---|
| `AWS_EMAIL_MODE` | `ses` |
| `AWS_EMAIL_FROM` | `ChecksOps <support@checksops.com>` |
| `AWS_EMAIL_ALLOWLIST_DOMAINS` | `checksops.invalid,checksops.com,freedomadj.com,gmail.com` |

Money flags unchanged: `AWS_CHECKALT_ENABLED=true`, `AWS_PROVIDER_EXECUTION_ENABLED=true`, `AWS_ENDORSEMENT_AUTO_ADVANCE=false`, `AWS_MOOV_ENABLED=false`.
Cognito configuration unchanged.

Allowlist still sinks recipients outside those domains. Existing production signers are `gmail.com`. `freedomadj.com` covers the operator test mailbox.

## G. Real SES delivery test

Authorized operator recipient: `claims@freedomadj.com` (Outlook-connected). No customer mailbox.

Staff `mcarletta@freedomadj.com` → `POST /prep/functions/v1/send-email` → `sendViaSesOrSink` → SES.

1. Probe: subject `ChecksOps SES activation test 6c95` — `stagingMode=ses`, MessageId `010001a0cee5f686-b9670be1-2cf6-4298-92b6-03346803b95b-000000`.
2. Public-link mail: subject `Action Required: View your claim documents` — MessageId `010001a0cee723a3-15cf803e-a008-4f14-87a3-45332d746640-000000`.

`homeowner-ledger-send` is still GRANT-denied for the application role (`permission denied for table homeowner_ledger_tokens`). That is a table-privilege issue, not SES. The same mailer path (`send-email`) delivered the ledger URL.

## H. Received-email evidence

Both messages arrived at `claims@freedomadj.com` from `Freedom Adjustment via ChecksOps <support@checksops.com>` with Amazon SES Message-IDs. Subjects and bodies were reasonable. No `ChecksOps Staging`.

## I. Public-link acceptance

`https://checksops.com/ledger/<token>` opened. `homeowner-ledger-view` resolved to claim `034882580`. Temporary token revoked after acceptance.

## J. Regression

| Check | Result |
|---|---|
| `/prep/health` | 200 `production-prep` ok |
| Cognito / staff session | refresh + `/identity/me` 200 Freedom admin |
| Checks query `0000549229` | 200 `needs_review` / `review` |
| `preview-transactional-email` | `stagingMode=ses` |
| Public Sign missing/invalid | 400 `validate_token` / 404 `fetch_signer` |
| Public Endorse missing/invalid | 400 Token required / 404 `token_consumed` |
| Public branding Freedom logo | 200 PNG (`2eff5f1a-…/logo-1780430426935.png`) |

Inspect Lambda restored to SHA `yYb/cXdUXkVh6JIesDAXwPcLmPwyTy86WwWvf4+xyso=`.

## K. PRODUCTION EMAIL DELIVERY — COMPLETE: YES

CLOSED and FROZEN.

## L. Remaining blocker before FIRST NEW REAL CHECK UPLOAD

None from SES/staff-review. Upload itself was not re-exercised. Recipients outside the allowlist still sink.

## M. Remaining blocker before DEPOSIT

CheckAlt E14 / deposit execution. `AWS_ENDORSEMENT_AUTO_ADVANCE` stays false. Do not begin here.

## N. Remaining blocker before DISBURSEMENT

Moov remains disabled. Do not begin here.

## O. Production components now FROZEN

1. AWS Cognito production foundation
2. AWS `/prep` API foundation
3. RDS/S3 production foundation
4. OCR / AWS Textract
5. Tenant branding / public assets
6. Public Sign / Endorse / Homeowner upload / Ledger / tracking
7. Production staff check operations
8. **Production application SES email delivery**

## P. SINGLE NEXT MASTER AWS CUTOVER ITEM

FIRST NEW REAL PRODUCTION CHECK UPLOAD (still excluding deposit / CheckAlt / Moov / money movement).

Not begun.
