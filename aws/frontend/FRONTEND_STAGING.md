# AWS staging frontend (Cognito + staging API)

Isolated ChecksOps frontend for AWS staging. Production Lovable/Supabase, production DNS, and `main` are not changed.

Staging frontend (current HTTP S3 website — temporary until HTTPS CloudFront):

http://checksops-staging-frontend-c48b.s3-website-us-east-1.amazonaws.com/

HTTPS target (after ACM + Cloudflare DNS — see `HTTPS_CLOUDFRONT.md` / `DNS_CHECKPOINT.md`):

https://staging.checksops.com

Results: `aws/frontend/FRONTEND_STAGING_RESULTS.md`.

## Public configuration (browser-safe)

Set in `.env.aws` (gitignored) or copy from `.env.aws.example`:

- `VITE_AUTH_PROVIDER=cognito`
- `VITE_APP_URL=https://staging.checksops.com`
- `VITE_CHECKSOPS_API_URL=https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging`
- `VITE_COGNITO_USER_POOL_ID=us-east-1_vPmQ7cL1F`
- `VITE_COGNITO_USER_POOL_CLIENT_ID=71bb7a192cbl6o6s8m259tl589`

Passkeys (Cognito native WebAuthn) enable only when the browser origin is exactly `https://staging.checksops.com`. HTTP S3 / unexpected hosts fail closed and keep EMAIL_OTP.

RDS passwords, AWS keys, Moov/CheckAlt/Plaid/Resend secrets must never be `VITE_*` values. The browser never connects to RDS.

## Commands

```bash
cp .env.aws.example .env.aws
npm run dev:aws
npm run build:aws
npm run preview:aws
node --test aws/tests/api-auth-data.test.mjs
```

`vite build` / production mode still uses `.env.production` and the Supabase client.

## Auth adapter

`src/integrations/aws/client.ts` replaces the generated Supabase browser client when `isAwsStaging()` is true.

1. Email/password → `POST /auth/login` (Cognito `USER_PASSWORD_AUTH` via Lambda, not from the browser).
2. `NEW_PASSWORD_REQUIRED` → login UI collects a permanent password → `POST /auth/challenge`.
3. Forgot password → `POST /auth/forgot` (Tester mailbox only).
4. Confirmation code → `POST /auth/confirm-forgot` (Tester only).
5. Session restore / refresh / logout as listed in the inventory.
6. `/identity/me` maps Cognito `sub` to the existing ChecksOps UUID. `user.id` in the UI is that UUID.

## Data

Authenticated reads use `POST /data/query` and `POST /data/rpc`. Lambda sets `request.app_user_id` from `identity_accounts` and RLS is the database authorization boundary.

Writes return `writes_disabled`. Provider functions return `provider_disabled`. Storage reads use authenticated S3 presigns after RLS; uploads return `uploads_disabled`.

## Do not

- Change production frontend, DNS, or Lovable/Supabase
- Merge AWS cutover into `main`
- Migrate production Storage
- Enable production writes / `default_transaction_read_only=off`
- Call Moov, CheckAlt, or Plaid
- Modify the unresolved ninth UUID
- Activate the disabled probe
