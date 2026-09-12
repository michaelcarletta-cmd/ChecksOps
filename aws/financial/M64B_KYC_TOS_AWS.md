# M6.4B — Migrate recipient KYC + ToS writes to AWS

**STOP FOR REVIEW.** Dummy token only in this agent pass. Do not open the real
recipient link here. Do not submit SSN/DOB, accept ToS, or send a verification
deposit.

## Inventory (live SPA before this phase)

| Action | Before | After |
|---|---|---|
| Session load | AWS `POST /prep/public/moov-recipient-session` | unchanged |
| KYC submit | Lovable `moov-recipient-kyc-update` | AWS `POST /prep/public/moov-recipient-kyc-update` |
| ToS Drop oauth | `session.token` (AWS returned `null`) | AWS `POST /prep/public/moov-recipient-tos-token` |
| ToS accept | Lovable `moov-recipient-tos-accept` | AWS `POST /prep/public/moov-recipient-tos-accept` |
| Bank add / verify / MV | Edge invoke | **not migrated**; UI held |

## Authorization

Public pay-setup `secure_token` only. No Cognito. Server resolves the recipient
via db-bridge and PATCHes **only** `provider_account_id` from that row.

Browser `recipient_id` / `account_id` / `tenant_id` / `provider_account_id`
are not authority. Mismatch or spoofed Moov ids fail closed.

Token is not consumed.

## Sensitive data

SSN/DOB transit only in the Moov PATCH JSON body. Never logged, never returned,
never placed in query strings, never stored in ChecksOps. Provider errors are
redacted. Fail closed.

## ToS

Drop oauth scopes are `recipientTosDropScopes(serverAccountId)` (`profile.write`,
`profile.read`, `ping.read`). Accept requires a Moov.js Drop token. Browser
`accepted=true` is forged. Duplicate accept is idempotent (`already_accepted`).

ToS is not accepted on behalf of the human.

## Bank / money

No bank-verify routes. SPA hides “Send verification deposit” and MV confirm.
Money flags stay false. Narrow flag
`AWS_PROVIDER_RECIPIENT_KYC_TOS_WRITES_ENABLED` allows only
`PATCH /accounts/{boundAccountId}`. Transfers and `/verify` remain denied.

## Deploy

| Item | Value |
|---|---|
| Lambda | `checksops-production-prep-api` CodeSha256 `fzKym3Al65mKO/t3v4Z9i7/bP5hEh+0Fsil0BIWYApQ=` |
| `auth-cognito.mjs` | unchanged `d3c8178fd5fa9709da055e0fbed3ec41dc2243d8f4a729479257a6decb0cd199` |
| Narrow write flag | `AWS_PROVIDER_RECIPIENT_KYC_TOS_WRITES_ENABLED=true` |
| Money flags | all execution flags **false**; live reads **true**; webhook dry-run **true** |
| SPA | production `vite build`; cleaned `index.html` (no VitePWA `registerSW`) |
| Live HTML | `/assets/index-DtzQLKI8.js` |
| Pay-setup chunk | `/assets/RecipientPaymentSetup-BwvGV6K0.js` |
| Invalidation | `I2IJ375OEWAMHDB70JF40NBW6S` `/*` on `E1B0ZWWO5559U5` |
| `/sw.js` | M6.3D kill-switch unchanged (685 bytes) |

Dummy 64-`a` token: AWS session/KYC/ToS-token/ToS-accept all HTTP 404 `This link is not valid.`
`verify_bank` on the KYC route: HTTP 403 `provider_execution_blocked`.
Live chunk contains AWS KYC/ToS paths and does not contain `functions.invoke` or `moov-recipient-bank-verify`.

## Return card

```
AWS KYC ROUTE: POST https://checksops.com/prep/public/moov-recipient-kyc-update
AWS TOS ROUTE: POST https://checksops.com/prep/public/moov-recipient-tos-token (Drop oauth) and POST https://checksops.com/prep/public/moov-recipient-tos-accept
SESSION AUTHORIZATION: existing pay-setup secure_token; not consumed; no Cognito
SERVER ACCOUNT BINDING: recipient.provider_account_id from db-bridge (ee8c608e-dc2d-45d3-95e9-3c992f3dfc5f)
SSN/DOB LOGGING: redacted; never returned
PLAINTEXT SSN STORAGE: none (no ChecksOps persist)
LOVABLE KYC CALLED: NO (SPA chunk has no Edge invoke)
LOVABLE TOS CALLED: NO
SPA DEPLOYED: YES
TESTS: PASS (aws-api 652 pass / 0 fail; M6.4B handler suite PASS)
LIVE TARGET UNCHANGED: YES
BANK VERIFICATION ENABLED: NO
MICRODEPOSIT INITIATED: NO
MONEY FLAGS: AWS_MOOV_ENABLED=false AWS_PROVIDER_EXECUTION_ENABLED=false AWS_FINANCIAL_PERMISSIONS_ACTIVATED=false
MONEY MOVED: NO
SAFE FOR MICHAEL TO COMPLETE KYC: YES
SAFE FOR MICHAEL TO ACCEPT TOS: YES (after KYC; hosted Drop only; do not fake accepted=true)
GO/NO-GO: GO for Michael to complete KYC then ToS on the existing link. Do not send a verification deposit.

STOP FOR REVIEW.
```


- Recipient `62a858ff-ee6a-49d7-9898-1c8e4a44227b`
- Moov account `ee8c608e-dc2d-45d3-95e9-3c992f3dfc5f`
- Bank Chase last4 `1506`
