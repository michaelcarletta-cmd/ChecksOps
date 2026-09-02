# AWS staging frontend results

Phase: ChecksOps AWS staging frontend integration (read-only). Production Lovable/Supabase, production DNS, and `main` were not changed. `default_transaction_read_only=on` remains on. The ninth UUID and disabled probe were not touched. Moov, CheckAlt, and Plaid were not called.

## Staging frontend URL

Isolated S3 website (no production DNS, HTTP only; CloudFront is not permitted on the Cursor staging role):

http://checksops-staging-frontend-c48b.s3-website-us-east-1.amazonaws.com/

API: `https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging`

Cognito pool `us-east-1_vPmQ7cL1F`, web client `71bb7a192cbl6o6s8m259tl589`. Browser config is public IDs + API URL only. No RDS, AWS, or provider secrets in the bundle. The browser never connects to RDS.

`vite build --mode aws` was uploaded to bucket `checksops-staging-frontend-c48b`. SPA deep links on the S3 website return HTTP 404 with `index.html` as the error document (React Router still boots). Local `vite preview --mode aws` on port 4173 was used for interactive UI proof (HTTP 200 on `/login`).

## Frontend authentication

Adapter: `src/integrations/aws/client.ts`, enabled only when `VITE_AUTH_PROVIDER=cognito`.

| Flow | Implementation |
| --- | --- |
| Email/password | `POST /auth/login` → Cognito `USER_PASSWORD_AUTH` via Lambda |
| `NEW_PASSWORD_REQUIRED` | Login UI + `POST /auth/challenge` |
| Forgot password | `POST /auth/forgot` (Tester mailbox only) |
| Confirmation code / reset | `POST /auth/confirm-forgot` (Tester only) |
| Session restore / refresh | localStorage + `POST /auth/refresh` |
| Logout | `POST /auth/logout` + clear session |
| Expired / invalid | 401 clears session; UI returns to login |

`user.id` is the ChecksOps application UUID from `GET /identity/me`, not the Cognito sub.

Identity chain holds: Cognito sub → `identity_accounts.application_user_id` → existing ChecksOps UUID → `request.app_user_id` → `auth.uid()`.

## AWS API routes implemented this phase

- `POST /auth/login`
- `POST /auth/challenge`
- `POST /auth/refresh`
- `POST /auth/forgot`
- `POST /auth/confirm-forgot`
- `POST /auth/logout`
- `POST /data/query` (allowlisted SELECT, filters, embeds)
- `POST /data/rpc` (read RPC allowlist)
- `POST/PUT/PATCH/DELETE /data/*` → `writes_disabled`
- `/storage/sign`, `/storage/sign-many`, `/storage/list`, `/storage/download` → authenticated S3 presign after RLS
- `GET /storage/public` → branding only
- other `/storage*` → `uploads_disabled`
- `POST /public/signature-document`, `/public/endorsement` → token pages (submit `writes_disabled`)
- `/functions*` → `provider_disabled`
- Unauthenticated `tenants_public` SELECT only

Live Lambda `checksops-staging-api` was updated in place (no SAM stack replace).

## Remaining Supabase frontend dependency inventory

See `aws/frontend/SUPABASE_FRONTEND_INVENTORY.md`. Totals from `src/`:

- 87 `supabase.auth.*` → Cognito adapter
- 649 `.from()` table reads / 125 tables → `/data/query` (no Supabase fallback in AWS mode)
- 87 `.rpc()` / 61 names → read allowlist or `rpc_disabled`
- 123 `functions.invoke` / 75 names → `provider_disabled`
- 18 `storage.from` / 7 buckets → AWS Storage API in Cognito mode (uploads gated)
- 293 browser DML → `writes_disabled`
- 23 realtime → no-op
- Public token pages `Sign.tsx` / `Endorse.tsx` use AWS `/public/*` in Cognito mode; production keeps the hardcoded Supabase URL fallback

Nothing was deleted because AWS coverage is incomplete.

## Freedom Tester UI results

Account `checksops-tester@freedomadj.com` → application UUID `abd3c2a0-6dc0-4680-92dd-a013e1141c91` → Cognito sub `c4386408-60e1-70e2-abb6-e6194e8e635f` (not equal).

API (RLS): 83 Freedom claims (`org_id=2eff5f1a-929d-4ce3-9a8b-cd96b98df42a`), 0 NULL-org claims, 0 C1C claims, 182 Freedom checks.

UI: login at `/login` → `/freedom/checks`. Header **FREEDOM ADJUSTMENT**. Settings company name Freedom Adjustment, slug `freedom`. Dashboard loaded (Review 28, Endorsing 22, Deposited 14, Returned 1, Loss Draft 11, Messages 7). No C1C tenant branding. Logout returned to `/freedom/login`.

## C1C UI isolation results

Account `payments@condition1commercial.com` → application UUID `fd857564-9534-4b0f-95ac-624ed1273725`.

API: 0 claims (0 Freedom, 0 NULL-org), 0 checks. Spoofed `X-User-Id` (Tester UUID), `X-Tenant-Id` (Freedom), and `X-Role: staff` were ignored; still 0 Freedom rows.

UI: `/login` → `/c1c/checks`. Unauthenticated `/freedom/checks` redirects to login. Authenticated C1C visit to `/freedom/checks` shows **Access Denied** for Freedom Adjustment's workspace. Dashboard counts were empty (no Freedom checks). Sign-out to `/c1c/login`.

## Forgot-password email / reset result

UI `/forgot-password` with **only** `checksops-tester@freedomadj.com` advanced to the confirmation-code form. Copy references the approved Tester mailbox.

API: Tester `ForgotPassword` is invoked; `payments@condition1commercial.com` returns `sent: false, suppressed: true` and does not call Cognito.

Reset completion (code + new password) was **not** finished from this environment: the agent cannot read `checksops-tester@freedomadj.com`. No other users were emailed. Tester/C1C passwords used for UI login were set with `AdminSetUserPassword --permanent` (no email) after the previous password file was invalid.

## Remaining Storage dependencies

Not migrated. Stub only. Buckets: `claim-files`, `deposit-attachments`, `loss-draft-documents`, `company-branding`, `tenant-logos`, `endorsement-packets`, `homeowner-uploads`. Need a later S3 copy with path mapping; no production Storage move in this phase.

## Remaining write / provider dependencies

`default_transaction_read_only=on`. 293 frontend DML paths return `writes_disabled`. 75 invoke names (Moov, CheckAlt, Plaid, Resend, Stripe, QuickBooks, OCR, signatures, invites) return `provider_disabled`. Financial/provider operations stay disabled until a later approved phase.

## Security regression

- Browser `user_id` / tenant / role in headers, query, and body are recorded as `spoofFieldsIgnored` and never set `request.app_user_id`.
- Invalid token → 401 `invalid_cognito_token`.
- Unauthenticated `/data/query` on `claims` → 401; only `tenants_public` is allowed without a token.
- RLS remains the database authorization boundary (83/0/182 vs 0/0/0).
- Cognito groups are not used for authorization.

## Failures / blockers

- No CloudFront permission on `ChecksOpsCursorCloudStaging`; staging UI is an HTTP S3 website (SPA `/login` is HTTP 404+index.html). Interactive UI tests used `vite preview`.
- Forgot-password **code** not confirmed (mailbox not readable here).
- C1C restored claim/check rows visible through RLS are 0 (isolation still proven: cannot see Freedom).
- Hardcoded production Supabase fallbacks remain in public `Sign` / `Endorse` token pages.
- Realtime is a no-op; some dashboard numbers rely on polling/RPCs.

## Migration completion (updated)

Staging parallel path now covers: isolated DB copy, global RLS (165 tables / 165 `aws_select_*` / 127 `aws_write_*` / 47 identity FKs), Cognito mapping for eight users, login, and authenticated **read-only** ChecksOps UI for Tester and C1C.

Still remaining before production cutover: S3/Storage migration; enable writes with `default_transaction_read_only` off under RLS; provider (Moov/CheckAlt/Plaid/Resend) server-side ports; realtime; public token pages; ninth UUID; production DNS/frontend cutover. Production ChecksOps stays on Lovable/Supabase.
