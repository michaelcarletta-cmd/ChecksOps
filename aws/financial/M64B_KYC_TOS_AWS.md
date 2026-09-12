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

## Live target (unchanged)

- Recipient `62a858ff-ee6a-49d7-9898-1c8e4a44227b`
- Moov account `ee8c608e-dc2d-45d3-95e9-3c992f3dfc5f`
- Bank Chase last4 `1506`
