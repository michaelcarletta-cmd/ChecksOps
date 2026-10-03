# M6.4E.2 — Final bank-verify activation pre-flight

**STOP FOR REVIEW.** Bank-verify writes stay **false**. No microdeposit. No MV code.
Do not enable `AWS_PROVIDER_RECIPIENT_BANK_VERIFY_WRITES_ENABLED`.
Do not enable Moov / CheckAlt / provider execution / financial-permissions / sandbox-execution.
Do not `UpdateStack` `checksops-production-prep-api`. Do not deploy `checksops-staging-api`.
Do not open the real pay-setup token in a browser.

This phase deploys the reviewed bank-verify SPA (button stays dark while the flag is
false), proves live pay-setup uses AWS initiate/confirm (not Lovable Edge), and
GET-only preflights the real target. Enablement is **not** in this phase.

## Live overlay (probe only)

E.1 already overlaid the three bank-verify files. E.2 replaced **only**
`providers/recipient-bank-verify-state-probe.mjs` on the historical live zip
(7478 zip members preserved). Do not add later `main` files to “fix”
`/functions/v1/*` — those money stubs fail closed on the missing Class A
`tenant-email-domain-handlers.mjs` that was already absent from the E.1 zip.

| Field | Value |
|---|---|
| Function | `checksops-production-prep-api` |
| CodeSha256 | `WsR7gYZPO+emNtQyGDi3gkY4FCPletVbfpbZOXvsJ6g=` |
| LastModified | `2026-09-13T11:45:23Z` |
| Env keys | 32, unchanged |
| `AWS_PROVIDER_RECIPIENT_BANK_VERIFY_WRITES_ENABLED` | `false` |
| Money / Moov / CheckAlt / sandbox-execution / financial-permissions | all `false` |
| `AWS_PROVIDER_LIVE_READS_ENABLED` | `true` (pre-existing) |
| `AWS_PROVIDER_RECIPIENT_KYC_TOS_WRITES_ENABLED` | `true` (pre-existing; not changed) |

`action=preflight_target` is GET-only: Dynamo `GetItem` of the exact
`CLAIM#{recipient}#{account}#{bank}` / `STATE` key (missing Item is not a
`not_started` stub) plus Moov GET account / capabilities / banks / bank /
`/verify` / payment-methods via `productionMoovFetch` `mode: 'read'`.
Never Put/Update/Delete. Never POST `/verify`.

## SPA deploy

Production `vite build` (not `--mode aws`). VitePWA `registerSW` stripped from
`dist/index.html`. Did **not** upload `sw.js` / `registerSW.js` / workbox.
Live kill-switch `/sw.js` left in place.

Bucket: `checksops-production-frontend-806168576068`. Sync `dist/assets`
without `--delete`, then cleaned `index.html`. CloudFront invalidation
`I2TRYG85ME5DBAKJVGBC35MSFS` `/*` on `E1B0ZWWO5559U5`.

| Asset | Hash |
|---|---|
| index | `/assets/index-ByTwb1fQ.js` |
| pay-setup chunk | `/assets/RecipientPaymentSetup-Bizl4i1o.js` |

The chunk contains `/public/moov-recipient-bank-verify-initiate`,
`/public/moov-recipient-bank-verify-confirm`, `Send verification deposit`,
and `Bank verification is not available yet.`. It does **not** contain
`functions.invoke`.

Full `index.html` swap was required because the new pay-setup chunk imports
`./index-ByTwb1fQ.js`. That also ships current `main` frontend hashes onto
checksops.com, same pattern as M6.4A/B.

UI gate: `bank_verify_available` is `providerRecipientBankVerifyWritesEnabled()`
in `public-moov-recipient-session.mjs`. Send/Confirm render only if that is
true. Flag false → unavailable copy; the button is not actionable.

Dummy pay-setup token (64 letter `a`, valid hex shape, not the real token)
POSTs `https://checksops.com/prep/public/moov-recipient-session` and returns
404 `This link is not valid.`, `liveProviderCalled=false`,
`token_consumed=false`. The real token was never opened.

Browser (dummy URL only): page title “Secure payment setup”, error
“This link is not valid.”, no Send/Confirm controls. DevTools Network:
POST `https://checksops.com/prep/public/moov-recipient-session` 404;
assets `index-ByTwb1fQ.js` and `RecipientPaymentSetup-Bizl4i1o.js`; no
`lovable.app` / supabase functions requests.

## GET-only live preflight (real target, not mutated)

- recipient `62a858ff-ee6a-49d7-9898-1c8e4a44227b`
- Moov account `ee8c608e-dc2d-45d3-95e9-3c992f3dfc5f`
- bank `72eb66c1-d9a9-4f85-ab50-8871db9ceeea` (JPMORGAN CHASE BANK, NA ••••1506)

| Check | Result |
|---|---|
| KYC | `verified` |
| ToS | accepted `2026-09-12T17:37:31.697535Z` on the exact account |
| Banks on account | 1, exact Chase id, last4 `1506`, status `new` |
| `/verify` | HTTP **404** (`missing: true`) |
| verification_status | `not_started` |
| should_initiate | `true` |
| initiated | `false` |
| method | `instant_micro_deposit` |
| Real-target DDB claim | `exists: false` (`GetItem` ok) |
| Duplicate bank on this Moov account | no |
| `payment_method_count` | 3 (Moov method objects on the bank, **not** transfers) |
| `provider_http` | true (GETs) |
| `provider_http_write` / `dynamo_write` | false |
| `microdeposit_initiated` / `mv_code_submitted` | false |

## DB bridge (read-only)

`aws-staging-db-bridge` health: `read_only`; writes/deletes/rpc/rawSql false.
`payment_transfers`: **0**. Target recipient still `awaiting_bank`,
`token_used_at=null`. Three rows last4 `1506`; only one is bound to the target
Moov account. One `payment_wallets` row is an operating wallet on a **different**
account (`60922058-…`), not the recipient.

## Blast radius if only the bank-verify flag is enabled

`assertRecipientBankVerifyWrite` allows only POST/PUT
`/accounts/{bound}/bank-accounts/{boundBank}/verify`. Transfer / ACH / RTP /
wire keys on the public initiate handler return **403**
`provider_execution_blocked`, `liveProviderCalled=false`.

Bank-verify handler also 403s if Moov / provider-execution / financial-
permissions flags are on. `executionAllowed('moov')` needs **both**
`AWS_MOOV_ENABLED` and `AWS_PROVIDER_EXECUTION_ENABLED`.

`/functions/v1/moov-disburse`, transfer-create, wallet-fund, CheckAlt
deposit, and the generic micro-deposit stub **fail closed** (missing
`tenant-email-domain-handlers.mjs` in the historical live zip). Bank-verify /
session / probe / `/financial/status` run before that import and still work.

Dark initiate/confirm (flag still false) remain **403**
`recipient_bank_verify_writes_blocked`.

GET `/financial/status` 200: all execution flags false;
`liveProviderTransactions=false`; `productionExecution=false`.

## Holds that remain

Do not enable `AWS_PROVIDER_RECIPIENT_BANK_VERIFY_WRITES_ENABLED`.
Do not initiate a microdeposit or submit an MV code.
Do not enable Moov / CheckAlt / provider execution / financial-permissions /
sandbox-execution.
Do not apply SQL72. Do not change Cognito/TOTP. Do not move money.
Do not deploy `checksops-staging-api`. Do not `UpdateStack`
`checksops-production-prep-api`.
Do not open the real pay-setup token.
