# MOOV M6.3 / M6.3A — AWS RECIPIENT SESSION READS

**STOP FOR REVIEW.** Session **reads** only. Do not submit KYC, accept ToS, verify bank, or move money.

Public route: `POST /prep/public/moov-recipient-session`

- Auth is the existing pay-setup `secure_token`. No Cognito JWT.
- Recipient and Moov account ids are server-derived. Browser Moov ids are rejected.
- Token source of truth during cutover: **live Lovable/Supabase production** via `aws-staging-db-bridge` `recipient_session_resolve`. AWS RDS copies omit `secure_token` and RLS hides recipient rows from the Lambda role.
- Tokens are UUID or 32–128 hex. Malformed / PostgREST-operator values fail closed (404) without lookup.
- GET-only Moov: account, capabilities, bank-accounts, payment-methods. OAuth token POST only.
- RDS transactions `ROLLBACK` when used. `token_used_at` is never written.
- KYC/ToS/bank submit handlers remain on Lovable Edge.

`/pay-setup/:token` page-load is wired to this AWS route in source. **Do not deploy the SPA** until a real existing-link AWS session read is proven.

## M6.3A resolver

- Bridge is read-only (`writes/deletes/rpc/rawSql=false`). GET PostgREST only.
- Lookup accepts only the submitted `token` (`provider=eq.moov`, `limit=1`). No recipient/account id filters.
- Response omits `secure_token`.
- Production project only: `nbcqwpysqgyxrrbgtmkw`. Forbidden refs: `sqyyvpaymashtdwjjmku`.
- Deploy: `scripts/m63a-deploy-db-bridge.sh` (this function only, `--no-verify-jwt`).
- Lambda `CHECKSOPS_DB_BRIDGE_TOKEN` is the existing production bridge auth secret `checksops/staging/storage-migration-token` (name is historical; it authenticates the production bridge). Do not copy a different staging-project token. Set only after live health lists `recipient_session_resolve`.
