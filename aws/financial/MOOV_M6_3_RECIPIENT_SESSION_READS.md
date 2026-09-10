# MOOV M6.3 — AWS RECIPIENT SESSION READS

**STOP FOR REVIEW.** Session **reads** only. Do not submit KYC, accept ToS, verify bank, or move money.

Public route: `POST /prep/public/moov-recipient-session`

- Auth is the existing pay-setup `secure_token`. No Cognito JWT.
- Recipient and Moov account ids are server-derived. Browser Moov ids are rejected.
- Token lookup uses live production (`aws-staging-db-bridge` `recipient_session_resolve`). AWS RDS copies omit `secure_token` and RLS hides recipient rows from the Lambda role.
- GET-only Moov: account, capabilities, bank-accounts, payment-methods. OAuth token POST only.
- RDS transactions `ROLLBACK` when used. `token_used_at` is never written.
- KYC/ToS/bank submit handlers remain on Lovable Edge.

`/pay-setup/:token` page-load calls this AWS route on checksops.com. Mutation buttons still invoke Edge.
