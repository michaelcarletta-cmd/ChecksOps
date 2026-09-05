# `profiles.preferred_auth_method` — AWS staging decision

**Added to staging schema:** **NO**

Live production has `profiles.preferred_auth_method` as `text NOT NULL` (bridge schema inspect, 2026-09-05). The production Account Security page still reads/writes it, and CheckOps signup stores it on the Supabase Auth metadata path.

AWS staging does **not** use this column for sign-in:

- CheckOps / WhiteLabel / MortgageOps login on AWS is Cognito WebAuthn + EMAIL_OTP (`src/pages/checkops/CheckOpsLogin.tsx`, `aws/functions/api/auth-webauthn.mjs`).
- The AWS write allowlist allows `profiles` updates for `full_name` / `phone` only and lists `preferred_auth_method` in `clientIgnored`, so the API will not persist it.
- Production passkeys are not migrated; AWS passkeys are separate Cognito credentials.

Adding the column would only make a leftover UI SELECT succeed. Writes would still be stripped. That is cosmetic schema parity, not AWS auth behavior.

If a later PR wants the Account Security preference control to work on AWS, that requires both the column **and** an allowlist/Cognito preference design — not this data-migration rehearsal.
