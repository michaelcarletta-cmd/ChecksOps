# ChecksOps frontend Supabase dependency inventory

Exact counts from `src/` (`*.ts` / `*.tsx`) taken before the AWS staging adapter. Production ChecksOps still uses these call sites. The staging client (`VITE_AUTH_PROVIDER=cognito`) intercepts them instead of deleting UI.

## Totals

| Kind | Count | Unique |
| --- | --- | --- |
| `supabase.auth.*` | 87 | 11 methods |
| `.from('…')` table queries | 649 | 125 tables |
| `.from('…')` storage buckets (hyphen names) | 59 | 7 buckets |
| `.rpc('…')` | 87 | 61 functions |
| `functions.invoke('…')` | 123 | 75 functions |
| `.storage.from()` | 18 | 5 buckets (plus 2 extra hyphen names via `.from`) |
| DML `.insert/.update/.upsert/.delete` | 293 | update 132, insert 100, delete 56, upsert 5 |
| Realtime `.channel` / `postgres_changes` | 23 | 7 files |
| `VITE_SUPABASE_*` / `SUPABASE_URL` env reads | 8 files | client, mortgage client, login/sign/endorse/unsubscribe, Zapier, verification files |

`.from()` raw regex hit 708 times; 59 of those are storage bucket names (`claim-files`, `company-branding`, `tenant-logos`, `deposit-attachments`, `loss-draft-documents`, `endorsement-packets`, `homeowner-uploads`), leaving **649 table queries / 125 tables**.

## Classification

### Cognito replacement (87)

All `supabase.auth.*` calls. Staging adapter maps them to AWS API `/auth/*` then `/identity/me`.

| Method | Count | Staging behavior |
| --- | --- | --- |
| `getUser` | 27 | Session restore; `user.id` is ChecksOps application UUID |
| `getSession` | 20 | ID token + refresh; refresh via `/auth/refresh` |
| `signOut` | 16 | `/auth/logout` + clear local session |
| `onAuthStateChange` | 6 | Local emitter |
| `resetPasswordForEmail` | 6 | `/auth/forgot` (Tester mailbox only) |
| `signInWithPassword` | 4 | `/auth/login` including `NEW_PASSWORD_REQUIRED` |
| `updateUser` | 3 | Staging uses confirmation code, not recovery session |
| `setSession` | 2 | Treats token as Cognito ID token |
| `refreshSession` | 1 | `/auth/refresh` |
| `signUp` | 1 | Disabled |
| `signInWithOtp` | 1 | Disabled |

Identity preserved: `Cognito sub -> identity_accounts.application_user_id -> existing ChecksOps UUID -> request.app_user_id -> auth.uid()`. The browser `user.id` is the ChecksOps UUID, never the Cognito sub.

### AWS API replacement already available

- `GET /identity/me`
- `GET /identity/session`
- `GET /authorization/isolation`
- `GET /authorization/jwks-check`
- `GET /db-health` (ops, not UI)

### AWS API route implemented this phase (instead of falling back to Supabase)

- `POST /auth/login`
- `POST /auth/challenge`
- `POST /auth/refresh`
- `POST /auth/forgot` (Tester only)
- `POST /auth/confirm-forgot` (Tester only)
- `POST /auth/logout`
- `POST /data/query` (allowlisted SELECT + filters + embeds)
- `POST /data/rpc` (read RPC allowlist)
- `POST/PUT/PATCH/DELETE /data/*` → `writes_disabled`
- `/storage/sign`, `/storage/sign-many`, `/storage/list`, `/storage/download` → authenticated S3 presign after RLS
- `GET /storage/public` → branding objects only
- other `/storage*` → `uploads_disabled`
- `/functions*` → `provider_disabled`
- Unauthenticated `tenants_public` SELECT only (white-label slug resolution)

### AWS API route still required (later phases)

Read RPCs not on the allowlist; complex PostgREST embeds beyond FK object/array; realtime; write RPCs listed below; storage uploads/deletes after authorization validation.

UI is **not** removed. Staging returns structured errors (`rpc_disabled`, `writes_disabled`, `uploads_disabled`, `provider_disabled`).

### S3 / storage migration required (18 `storage.from` + 7 bucket names)

| Bucket | Current ops | Staging |
| --- | --- | --- |
| `claim-files` | upload, signed URL, download, remove | signed URL / download / list via AWS API; upload/remove gated |
| `deposit-attachments` | upload / signed URL | signed URL via AWS API; upload gated |
| `loss-draft-documents` | upload / signed URL | signed URL via AWS API; upload/remove gated |
| `company-branding` | upload / public URL | public URL via `/storage/public` only if authorized; upload gated |
| `tenant-logos` | upload / public URL | `/storage/public` after `tenants_public` match; upload gated |
| `endorsement-packets` | path via `.from` | signed URL via AWS API |
| `homeowner-uploads` | path via `.from` | signed URL via AWS API |

Do not copy production Storage in this phase. Browser never receives S3 credentials.

### Server-side provider operations (75 invoke names / 123 calls)

Disabled on staging. Includes Moov, CheckAlt, Plaid, Resend, Stripe usage, QuickBooks, OCR, signatures, tenant invites. No browser-direct provider calls.

Highest-frequency invokes: `send-signature-request` (9), `check-endorsement` (6), `homeowner-claim-portal` (6), `get-check-image-urls` (5), `quickbooks-payment` (4), `moov-platform-bank` (4).

### Direct browser DML (293)

All go through `.insert/.update/.upsert/.delete` on the shared client. Staging adapter returns `writes_disabled`. `default_transaction_read_only=on` remains. Financial/provider writes stay disabled.

### Realtime (23)

No-op channel stub. Dashboard polling via read RPCs still works where allowlisted.

### Obsolete / dead code

None removed. Incomplete AWS coverage must not delete ChecksOps workflows.

## Priority workflow coverage (reads)

| Workflow | Mechanism |
| --- | --- |
| Current user / profile / tenant | `/identity/me` + `user_roles` + `tenant_users` + `tenants_public` |
| Dashboard | `get_check_dashboard_counts_for_tenant`, stage totals, unread counts |
| Checks / intake | `check_intake_items` SELECT |
| Endorsements | `check_endorsements` SELECT |
| Claims | `claims` SELECT (RLS) |
| Deposits | deposit tables + KPI RPCs |
| Disbursements | `disbursement_*` SELECT; send-money disabled |
| Homeowner ledger | ledger tables SELECT; send/upload disabled |
| Tenant settings | tenants / tenant_users SELECT |
| Payment / provider status displays | `payment_provider_accounts` SELECT; Moov/CheckAlt/Plaid invokes disabled |

Authorization evidence is only the Cognito token. Browser-provided `user_id`, tenant ID, and role headers/query/body are recorded as `spoofFieldsIgnored` and never used for `request.app_user_id`.
