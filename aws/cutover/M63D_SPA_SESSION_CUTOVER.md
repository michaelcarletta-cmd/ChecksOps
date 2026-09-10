# M6.3D — SPA session-load cutover (STOP FOR REVIEW)

**2026-09-10.** Deployed **only** the `/pay-setup/:token` session-load target. No KYC, ToS, bank, micro-deposit, money flags, or SQL72.

## Session load target

Live pay-setup chunk `RecipientPaymentSetup-B5c2YwKv.js` posts:

`POST ${window.location.origin}/prep/public/moov-recipient-session`

On `checksops.com` that is `https://checksops.com/prep/public/moov-recipient-session`.

Body is `{ token }` from the URL. The token is not written to `console`, errors, or analytics.

Lovable `functions.invoke("moov-recipient-session")` is no longer used on page load.

## Mutation handlers (unchanged, explicit click only)

Still `invoke("moov-recipient-kyc-update" | "moov-recipient-tos-accept" | "moov-recipient-bank-add" | "moov-recipient-bank-verify")`. AWS `AWS_MOOV_ENABLED=false` keeps those provider stubs disabled.

AWS session JSON returns `token: null`, so `js.moov.io` / ToS Drop does **not** run on page load.

## Deploy

| Item | Value |
|---|---|
| Build | `vite build --mode aws` (`VITE_CHECKSOPS_API_URL=/prep`, production Cognito) |
| Main bundle | `assets/index-B-TxXkkm.js` |
| Pay-setup chunk | `assets/RecipientPaymentSetup-B5c2YwKv.js` |
| Bucket | `checksops-production-frontend-806168576068` |
| Invalidation | `I5BQ7HWHLU3RP372R3V15Z644A` `/*` |
| S3 sync | assets + `index.html` only; **no** `--delete` |
| Rollback | previous `index-C4XNMerU.js` + `RecipientPaymentSetup-DJHOGOAV.js` left in the bucket |

## Proofs (dummy tokens only; real link not opened)

| Check | Result |
|---|---|
| Dummy UUID | HTTP 404, `liveProviderCalled=false`, `token_consumed=false` |
| Malformed `x` / PostgREST filter | HTTP 404 fail-closed |
| `provider_account_id` spoof | HTTP 400 `untrusted_provider_config` |
| Mutation flag on session POST | HTTP 400 `read_only_operation` |
| Money flags | all execution flags **false**; live reads **true**; webhook dry-run **true** |
| SQL72 | **NOT_APPLIED** |
| Lambda overlay | not changed this phase |

Real recipient `secure_token` was not retrieved, printed, rotated, or posted.

## STOP

User may open the **existing** pay-setup link once for a session **read**. Do not click KYC / ToS / bank / verify. Do not enable money flags. Do not apply SQL72.
