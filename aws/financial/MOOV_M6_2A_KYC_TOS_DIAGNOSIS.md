# MOOV M6.2A — KYC / TOS ONBOARDING DIAGNOSIS

**STOP FOR REVIEW.** Draft fix only. Do not merge. Do not deploy.
Do not create a Moov account, submit KYC, accept ToS, modify recipient/bank rows, register a webhook, apply SQL72, or move money.

## Live GET (2026-09-10)

Recipient `62a858ff…227b` / Moov `ee8c608e…fc5f`:

- production individual, not disabled/restricted
- `termsOfService` empty (`tos_field_keys: []`)
- account verification `unverified`; no individual verification object
- `send-funds` **pending** with `account.tos-acceptance`, `individual.address`, `individual.birthdate`, `individual.ssn`
- `transfers` **enabled**
- bank exists, status `new`, last4 `1506`
- ACH credit payment methods present
- Lambda restored after GET-only overlay; money routes 403

Existing account is **recoverable**. Do not replace it.

## Root cause

PR **#90** (2026-09-02) removed the Moov.js `<moov-terms-of-service>` Drop from `/pay-setup/:token` and replaced it with a local checkbox plus server-minted `/tos-token` scoped only to `/ping.read`. That token is not bound to the recipient account. ChecksOps then logged `recipient.terms_accepted` without confirming Moov ToS. Bank-add is ungated and can store last4 while KYC/ToS remain incomplete.

KYB (Condition One Commercial / Freedom tenant) used `moov-account-create` (`accountType: business`) + `moov-account-onboard` (representatives) and tenant ToS that can carry a Drop token onto the **tenant** connected account.

## Webhook

Missing AWS Moov webhook does **not** cause the original ToS failure. It only prevents automatic RDS sync after Moov later records KYC/ToS/bank verification.
