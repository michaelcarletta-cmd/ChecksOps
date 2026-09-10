# MOOV M6.3 — AWS RECIPIENT SESSION READS

**STOP FOR REVIEW.** Session **reads** only. Do not submit KYC, accept ToS, verify bank, or move money.

Public route: `POST /prep/public/moov-recipient-session`

- Auth is the existing pay-setup `secure_token`. No Cognito JWT.
- Recipient and Moov account ids are server-derived. Browser Moov ids are rejected.
- GET-only Moov: account, capabilities, bank-accounts, payment-methods. OAuth token POST only.
- Transaction always `ROLLBACK`. `token_used_at` is never written.
- KYC/ToS/bank submit handlers remain on Lovable Edge.

`/pay-setup/:token` page-load calls this AWS route on checksops.com. Mutation buttons still invoke Edge.
